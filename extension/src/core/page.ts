/**
 * Service-worker side of the page agent.
 *
 * Everything here runs the page agent through the DevTools Protocol
 * (Runtime.evaluate in a CDP-created isolated world) rather than
 * chrome.scripting.executeScript. The reason is measured, not theoretical:
 * browsers that suspend a background profile (Dia, which lets you swipe
 * between profiles) throttle chrome.scripting.executeScript in the suspended
 * profile until it hangs, while the debugger path keeps working. Routing the
 * agent through CDP means read_page, find, get_page_text, and form_input work
 * on a profile you are not currently looking at, which is exactly when an
 * agent should be driving it.
 *
 * The agent lives in a dedicated isolated world so its WeakRef ref map and
 * globals are invisible to the page and survive across calls, the same
 * isolation a content script would give without depending on chrome.scripting.
 */

import { PricklyError } from "@shared/protocol";
import { cdp } from "./cdp";

const PAGE_AGENT_FILE = "page-agent.js";
const WORLD_NAME = "prickly";

/** The agent source, fetched once from the packaged file. */
let agentSource: string | null = null;

async function loadAgentSource(): Promise<string> {
  if (agentSource !== null) return agentSource;
  const url = chrome.runtime.getURL(PAGE_AGENT_FILE);
  agentSource = await (await fetch(url)).text();
  return agentSource;
}

/** contextId of the isolated world we injected the agent into, per tab. */
const worlds = new Map<number, number>();

export function forgetWorld(tabId: number): void {
  worlds.delete(tabId);
}

interface FrameTree {
  frameTree: { frame: { id: string } };
}

interface CreateIsolatedWorld {
  executionContextId: number;
}

interface EvaluateResult {
  result: { type: string; value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/**
 * Ensures an isolated world exists for the tab's main frame with the agent
 * defined in it, and returns its execution context id. Cached; recreated when
 * a navigation has invalidated the old context.
 */
async function ensureWorld(tabId: number): Promise<number> {
  const cached = worlds.get(tabId);
  if (cached !== undefined) return cached;

  const session = cdp(tabId);
  await session.enable("Page");
  await session.enable("Runtime");

  const tree = await session.send<FrameTree>("Page.getFrameTree");
  const frameId = tree.frameTree.frame.id;

  const { executionContextId } = await session.send<CreateIsolatedWorld>(
    "Page.createIsolatedWorld",
    { frameId, worldName: WORLD_NAME, grantUniveralAccess: true },
  );

  // Define window.__prickly in the new world. The agent is idempotent, so a
  // re-inject after a navigation is harmless.
  const source = await loadAgentSource();
  const injected = await session.send<EvaluateResult>("Runtime.evaluate", {
    expression: `${source}\n;typeof window.__prickly !== "undefined"`,
    contextId: executionContextId,
    returnByValue: true,
  });
  if (injected.exceptionDetails || injected.result.value !== true) {
    throw new PricklyError(
      `Could not load the page agent: ${injected.exceptionDetails?.text ?? "unknown error"}`,
      "internal",
    );
  }

  worlds.set(tabId, executionContextId);
  return executionContextId;
}

/** A stale context reports this once its document has navigated away. */
function isStaleContext(detail: string): boolean {
  return (
    detail.includes("Cannot find context") ||
    detail.includes("Execution context was destroyed") ||
    detail.includes("Inspected target navigated") ||
    detail.includes("__prickly")
  );
}

/**
 * Calls a method on the page agent over CDP. The return value crosses
 * returnByValue, so it is plain JSON by the time we see it.
 */
async function invoke<T>(tabId: number, method: string, args: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const contextId = await ensureWorld(tabId);
    const expression = `(() => {
      const agent = window.__prickly;
      if (!agent) return { __pricklyError: "page agent is not loaded" };
      const fn = agent[${JSON.stringify(method)}];
      if (typeof fn !== "function") return { __pricklyError: "no page agent method ${method}" };
      try { return fn(...${JSON.stringify(args)}); }
      catch (err) { return { __pricklyError: String((err && err.message) || err) }; }
    })()`;

    let evaluated: EvaluateResult;
    try {
      evaluated = await cdp(tabId).send<EvaluateResult>("Runtime.evaluate", {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      if (isStaleContext(message) && attempt === 0) {
        worlds.delete(tabId);
        continue;
      }
      throw new PricklyError(`page agent call failed: ${message}`, "internal");
    }

    if (evaluated.exceptionDetails) {
      const detail =
        evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text;
      if (isStaleContext(detail) && attempt === 0) {
        worlds.delete(tabId);
        continue;
      }
      throw new PricklyError(`page agent threw: ${detail}`, "internal");
    }

    const result = evaluated.result.value as T | { __pricklyError: string } | undefined;
    if (result === undefined) {
      throw new PricklyError(
        "The page did not respond. It may be a restricted URL or still loading.",
        "internal",
      );
    }
    if (typeof result === "object" && result !== null && "__pricklyError" in result) {
      throw new PricklyError((result as { __pricklyError: string }).__pricklyError);
    }
    return result as T;
  }
  throw new PricklyError("page agent context kept going stale", "internal");
}

// ---------------------------------------------------------------------------
// Typed surface
// ---------------------------------------------------------------------------

export interface TreeOptions {
  maxDepth?: number;
  filter?: "all" | "interactive";
  rootRef?: string;
  maxChars?: number;
}

export interface TreeResult {
  text: string;
  truncated: boolean;
  fullLength: number;
  nodeCount: number;
  url: string;
  title: string;
}

/**
 * Evaluate a plain expression in the page's main world over CDP, for the few
 * callers that need page state but not the ref map (history navigation, a text
 * poll). Uses the debugger path so it works in a suspended profile too.
 */
export async function evalInPage<T>(tabId: number, expression: string): Promise<T> {
  const session = cdp(tabId);
  await session.enable("Runtime");
  const result = await session.send<EvaluateResult>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new PricklyError(
      `page eval threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      "internal",
    );
  }
  return result.result.value as T;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface SearchMatch {
  ref: string;
  role: string;
  name: string;
  score: number;
  detail: string;
}

export function readTree(tabId: number, options: TreeOptions): Promise<TreeResult> {
  return invoke<TreeResult>(tabId, "tree", [options]);
}

export function readText(tabId: number): Promise<string> {
  return invoke<string>(tabId, "text", []);
}

export function searchPage(
  tabId: number,
  query: string,
  limit: number,
): Promise<{ matches: SearchMatch[]; scanned: number }> {
  return invoke(tabId, "search", [query, limit]);
}

/**
 * Viewport-space centre of a ref, scrolled into view. Every ref-taking tool
 * funnels through this, which is why a stale ref fails loudly rather than
 * clicking the wrong thing.
 */
export async function refRect(tabId: number, ref: string): Promise<Rect> {
  const result = await invoke<
    { ok: true } & Rect | { ok: false; error: string }
  >(tabId, "rect", [ref]);
  if (!result.ok) throw new PricklyError(result.error, "internal");
  return result;
}

export async function setRefValue(
  tabId: number,
  ref: string,
  value: string,
): Promise<void> {
  const result = await invoke<{ ok: boolean; error?: string }>(tabId, "setValue", [
    ref,
    value,
  ]);
  if (!result.ok) throw new PricklyError(result.error ?? "could not set value");
}

export async function describeRef(
  tabId: number,
  ref: string,
): Promise<{ ref: string; role: string; name: string }> {
  const result = await invoke<
    { ok: true; ref: string; role: string; name: string } | { ok: false; error: string }
  >(tabId, "resolve", [ref]);
  if (!result.ok) throw new PricklyError(result.error, "internal");
  return result;
}
