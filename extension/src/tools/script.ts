/**
 * browser_script: the general escape hatch.
 *
 * Runs a model-authored async function with a curated `driver` API: raw CDP,
 * page eval, a CORS-free fetch, and session tab access. It is the honest
 * superset of the other scripting hooks, for imperative multi-step routines
 * and anything no discrete tool covers.
 *
 * The code cannot run in the service worker: MV3 forbids eval there. So it runs
 * in a page through CDP Runtime.evaluate, which is not subject to that CSP, and
 * the driver's service-worker powers (CDP, cookie-bearing fetch, cross-tab
 * access) are bridged back over a CDP binding. The model writes ordinary code
 * and never sees the seam.
 *
 * Two deliberate boundaries survive the power. It is scoped to the session's
 * tab group, so even this cannot touch a tab the agent did not open. And it is
 * a deliberate reach, the most privileged tool here, not a default.
 */

import { defineTool } from "../core/registry";
import { s } from "../core/schema";
import { PricklyError, text, type ToolResult } from "@shared/protocol";
import { requireTabInSession, resolveTab, sessionTabs, type Session } from "../core/sessions";
import { assertDrivable, redact as redactValue } from "../core/guards";
import { cdp } from "../core/cdp";

const SCRIPT_TIMEOUT_MS = 60_000;
const BINDING = "__pricklyBridge";

interface DriverResult {
  result: unknown;
  logs: string[];
}

/**
 * Services one driver call from the page. Everything here is scoped to the
 * session, so driver.cdp and driver.eval refuse tabs outside its group.
 */
async function dispatch(
  session: Session,
  method: string,
  args: unknown[],
): Promise<unknown> {
  // A tabId crosses the bridge as JSON, so an omitted one arrives as null, not
  // undefined. Treat both as "the session's active tab".
  const resolveId = async (tabId: unknown): Promise<number> => {
    if (tabId === undefined || tabId === null) {
      return (await resolveTab(session)).id!;
    }
    return (await requireTabInSession(session, tabId as number)).id!;
  };

  switch (method) {
    case "tabs": {
      const tabs = await sessionTabs(session);
      return tabs.map((t) => ({
        id: t.id,
        url: t.url ?? "",
        title: t.title ?? "",
        active: t.active ?? false,
      }));
    }
    case "cdp": {
      const [cdpMethod, params, tabId] = args as [string, Record<string, unknown>?, number?];
      const id = await resolveId(tabId);
      return cdp(id).send(cdpMethod, params ?? {});
    }
    case "eval": {
      const [expression, tabId] = args as [string, number?];
      const id = await resolveId(tabId);
      const tab = await requireTabInSession(session, id);
      assertDrivable(tab.url);
      const r = await cdp(id).send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
      );
      if (r.exceptionDetails) throw new PricklyError(r.exceptionDetails.text, "internal");
      return r.result.value;
    }
    case "fetch": {
      const [url, init] = args as [string, { method?: string; headers?: Record<string, string>; body?: string; credentials?: RequestCredentials }?];
      const res = await fetch(url, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body,
        credentials: init?.credentials ?? "include",
        redirect: "follow",
      });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, statusText: res.statusText, headers, body };
    }
    default:
      throw new PricklyError(`unknown driver method: ${method}`, "bad_params");
  }
}

const PRELUDE = `(() => {
  if (globalThis.__pricklyBridgeReady) return;
  globalThis.__pricklyBridgeReady = true;
  globalThis.__pricklyPending = new Map();
  let seq = 0;
  globalThis.__pricklyCall = (method, args) => new Promise((resolve, reject) => {
    const id = "c" + (seq++);
    globalThis.__pricklyPending.set(id, { resolve, reject });
    globalThis.${BINDING}(JSON.stringify({ id, method, args }));
  });
  globalThis.__pricklyResolve = (id, ok, payload) => {
    const p = globalThis.__pricklyPending.get(id);
    if (!p) return;
    globalThis.__pricklyPending.delete(id);
    ok ? p.resolve(payload) : p.reject(new Error(payload));
  };
})();`;

function wrap(sessionId: string, scriptBody: string): string {
  return `(async () => {
    const call = globalThis.__pricklyCall;
    const logs = [];
    const driver = {
      sessionId: ${JSON.stringify(sessionId)},
      tabs: () => call("tabs", []),
      cdp: (m, p, t) => call("cdp", [m, p ?? {}, t]),
      eval: (e, t) => call("eval", [e, t]),
      fetch: (u, i) => call("fetch", [u, i ?? {}]),
      log: (...a) => { logs.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); },
    };
    const run = async (driver) => { ${scriptBody}\n};
    const result = await run(driver);
    return JSON.stringify({ result: result === undefined ? null : result, logs });
  })()`;
}

async function runScript(session: Session, scriptBody: string): Promise<DriverResult> {
  const tab = await resolveTab(session);
  assertDrivable(tab.url);
  const tabId = tab.id!;
  const session_ = cdp(tabId);
  await session_.enable("Runtime");

  // Expose the bridge, wire the handler, inject the prelude.
  await session_.send("Runtime.addBinding", { name: BINDING });
  const off = session_.on("Runtime.bindingCalled", (params) => {
    const p = params as { name: string; payload: string };
    if (p.name !== BINDING) return;
    void serviceCall(session, session_, p.payload);
  });

  try {
    await session_.send("Runtime.evaluate", { expression: PRELUDE });

    const evaluated = await session_.send<{
      result: { value?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression: wrap(session.sessionId, scriptBody),
      returnByValue: true,
      awaitPromise: true,
      timeout: SCRIPT_TIMEOUT_MS,
    });

    if (evaluated.exceptionDetails) {
      throw new PricklyError(
        `script threw: ${evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text}`,
        "internal",
      );
    }
    const parsed = JSON.parse(evaluated.result.value ?? '{"result":null,"logs":[]}') as DriverResult;
    return parsed;
  } finally {
    off();
    await session_.send("Runtime.removeBinding", { name: BINDING }).catch(() => {});
  }
}

/** Handles a single bridged driver call and resolves the page-side promise. */
async function serviceCall(
  session: Session,
  cdpSession: ReturnType<typeof cdp>,
  payload: string,
): Promise<void> {
  let id = "";
  try {
    const { id: callId, method, args } = JSON.parse(payload) as {
      id: string;
      method: string;
      args: unknown[];
    };
    id = callId;
    const result = await dispatch(session, method, args);
    await cdpSession.send("Runtime.evaluate", {
      expression: `globalThis.__pricklyResolve(${JSON.stringify(id)}, true, ${JSON.stringify(result ?? null)})`,
    });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    await cdpSession
      .send("Runtime.evaluate", {
        expression: `globalThis.__pricklyResolve(${JSON.stringify(id)}, false, ${JSON.stringify(message)})`,
      })
      .catch(() => {});
  }
}

defineTool({
  name: "browser_script",
  description:
    "Runs a JavaScript function for logic no single tool covers: multi-step routines, raw CDP, " +
    "looping over data, decode-modify-reencode. The most powerful tool here, scoped to this " +
    "session's tabs. Write the body of `async (driver) => result`; the return value comes back.\n\n" +
    "driver.tabs() -> [{ id, url, title, active }]\n" +
    "driver.cdp(method, params?, tabId?) -> raw CDP result on a session tab\n" +
    "driver.eval(expression, tabId?) -> evaluate JS in the page, returns its value\n" +
    "driver.fetch(url, { method?, headers?, body?, credentials? }) -> { status, headers, body } " +
    "(cookies attached, CORS bypassed)\n" +
    "driver.log(...args) -> add a line to the returned log\n\n" +
    "Example, pull a value with CDP and compute:\n" +
    "  const r = await driver.cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true });\n" +
    "  driver.log('title:', r.result.value);\n" +
    "  return r.result.value.length;",
  mutating: true,
  input: {
    script: s.string({ description: "Body of async (driver) => result." }),
    redact: s.boolean({
      description: "Mask credential-looking keys in the returned value. Off by default.",
      default: false,
    }),
  },
  async execute(args, ctx): Promise<ToolResult> {
    const session = await ctx.requireSession();
    const { result, logs } = await runScript(session, args.script);
    const value = args.redact ? redactValue(result) : result;
    const parts: string[] = [];
    if (logs.length) parts.push("logs:", ...logs.map((l) => `  ${l}`), "");
    parts.push("result:", value === undefined || value === null ? "null" : safeString(value));
    return text(...parts);
  },
});

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
