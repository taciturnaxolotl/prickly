/**
 * Network tools: capture, query, intercept, replay.
 *
 * The security-research surface. A capture is per tab and stays alive across
 * tool calls, so you can start recording, drive the page, then read back
 * everything that happened. Bodies are fetched as responses land rather than
 * on demand, because Chrome evicts them quickly.
 */

import { defineTool } from "../core/registry";
import { s } from "../core/schema";
import { PricklyError, text } from "@shared/protocol";
import { resolveTab } from "../core/sessions";
import { assertDrivable } from "../core/guards";
import {
  addRule,
  captureState,
  clearCapture,
  disableInterception,
  enableInterception,
  getRecord,
  listRules,
  query,
  removeRule,
  replay,
  startCapture,
  stopCapture,
  summarize,
  type CapturedRequest,
  type InterceptAction,
} from "../core/network";

const MAX_BODY_CHARS = 100_000;

/** "Fetch: 33, Image: 210, Script: 40" for the largest few types. */
function typeBreakdown(requests: CapturedRequest[]): string {
  const counts = new Map<string, number>();
  for (const r of requests) {
    const t = r.resourceType ?? "Other";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}: ${n}`)
    .join(", ");
}

/** Walks a dot path into a JSON body and returns that slice re-serialized. */
function sliceJsonPath(body: string, path: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  for (const key of path.split(".")) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      value = value[index];
    } else if (typeof value === "object") {
      value = (value as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

function lineFor(r: CapturedRequest): string {
  const status = r.failed ? `FAIL ${r.failed.errorText}` : `${r.status ?? "..."}`;
  const size = r.body?.length ? `${Math.round(r.body.length / 1024)}KB` : "";
  return `${r.requestId.padEnd(14)} ${r.method.padEnd(6)} ${status.padEnd(6)} ${shortUrl(r.url)} ${size}`;
}

async function tabIdFor(
  ctx: { requireSession(): Promise<import("../core/sessions").Session> },
  tabId?: number,
): Promise<number> {
  const session = await ctx.requireSession();
  const tab = await resolveTab(session, tabId);
  assertDrivable(tab.url);
  return tab.id!;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

defineTool({
  name: "network_capture_start",
  description:
    "Starts recording network traffic for a tab. Keeps a ring buffer of requests with bodies, " +
    "survives across tool calls, and is what every other network tool reads from. Start this " +
    "before driving the page you want to study.",
  mutating: true,
  input: {
    tabId: s.number({ description: "Tab to record.", integer: true, optional: true }),
    max: s.number({ description: "Ring buffer size.", integer: true, min: 10, max: 5000, default: 500 }),
    maxBodyBytes: s.number({
      description: "Store response bodies up to this many bytes. 0 keeps metadata only.",
      integer: true,
      min: 0,
      max: 8 * 1024 * 1024,
      default: 256 * 1024,
    }),
    clear: s.boolean({ description: "Drop anything already buffered.", default: true }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);
    const state = await startCapture({ tabId, max: args.max, maxBodyBytes: args.maxBodyBytes });
    if (args.clear) clearCapture(tabId);
    return text(
      `Recording network traffic on tab ${tabId} (capture ${state.captureId}).`,
      `Buffer: ${args.max} requests, bodies up to ${Math.round(args.maxBodyBytes / 1024)}KB.`,
      `Read it back with network_requests. Stop with network_capture_stop.`,
    );
  },
});

defineTool({
  name: "network_capture_stop",
  description: "Stops recording and drops the buffer for a tab.",
  mutating: true,
  input: {
    tabId: s.number({ description: "Tab to stop recording.", integer: true, optional: true }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);
    await disableInterception(tabId).catch(() => {});
    const count = await stopCapture(tabId);
    return text(`Stopped capture on tab ${tabId}; discarded ${count} records.`);
  },
});

defineTool({
  name: "network_requests",
  description:
    "Lists captured requests. Filter by URL substring or /regex/, method, resource type, status " +
    "range, or a string that must appear in the response body. Bodies are not included; use " +
    "network_request_get for one.",
  batchable: true,
  input: {
    tabId: s.number({ description: "Tab whose capture to read.", integer: true, optional: true }),
    urlPattern: s.string({
      description: "Substring match, or /pattern/flags for a regex.",
      optional: true,
    }),
    method: s.string({ description: "GET, POST, ...", optional: true }),
    resourceType: s.enum_(
      ["Document", "Stylesheet", "Image", "Script", "Font", "XHR", "Fetch", "WebSocket", "Other"] as const,
      { description: "Chrome's resource type. XHR and Fetch are usually what you want.", optional: true },
    ),
    statusMin: s.number({ description: "Lowest status to include.", integer: true, optional: true }),
    statusMax: s.number({ description: "Highest status to include.", integer: true, optional: true }),
    bodyContains: s.string({ description: "Only requests whose response body contains this.", optional: true }),
    limit: s.number({ description: "Most recent N to return.", integer: true, min: 1, max: 500, default: 50 }),
    clear: s.boolean({ description: "Empty the buffer after reading.", default: false }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);
    const state = captureState(tabId);
    const buffered = state?.requests.length ?? 0;
    const results = query(tabId, args);

    if (!results.length) {
      // Distinguish "nothing captured" from "filter too narrow" by reporting
      // the buffer size and what resource types are actually in it. A capture
      // that started after the page loaded shows up as a near-empty buffer, and
      // an over-narrow filter shows up as a full buffer with zero matches.
      if (buffered === 0) {
        const age = state ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
        return text(
          `Nothing has been captured yet (buffer empty, capture running ${age}s). ` +
            `If the page loaded before capture started, its bootstrap requests are gone; ` +
            `reload the tab (navigate to the same URL) to capture them, then read again.`,
        );
      }
      const breakdown = typeBreakdown(state!.requests);
      return text(
        `0 of ${buffered} buffered requests match this filter.`,
        `The buffer has: ${breakdown}.`,
        `Loosen the filter. Note XHR and Fetch are separate types and modern apps ` +
          `use Fetch, so filtering resourceType:XHR alone often misses the API; omit ` +
          `resourceType to see both.`,
      );
    }

    const lines = results.map(lineFor);
    const header = `${results.length} of ${buffered} buffered request(s) on tab ${tabId}:`;
    const footer = args.clear
      ? "Buffer cleared."
      : `Use network_request_get with a requestId for headers and body.`;

    if (args.clear) clearCapture(tabId);
    return text(header, ...lines, "", footer);
  },
});

defineTool({
  name: "network_request_get",
  description:
    "Full detail for one captured request: headers, post data, response body. Credentials are " +
    "shown by default since this is a research tool; pass redact: true to mask them.",
  batchable: true,
  input: {
    requestId: s.string({ description: "From network_requests." }),
    tabId: s.number({ description: "Tab whose capture to read.", integer: true, optional: true }),
    includeBody: s.boolean({ description: "Include the response body.", default: true }),
    redact: s.boolean({
      description:
        "Mask credential-looking headers and keys. Off by default: this is a research tool and " +
        "the token is usually the point. Set true to keep secrets out of the transcript.",
      default: false,
    }),
    maxChars: s.number({ description: "Body characters to show from the offset.", integer: true, min: 500, max: MAX_BODY_CHARS, default: 20_000 }),
    bodyOffset: s.number({
      description: "Start showing the body this many characters in, to page through a large body.",
      integer: true,
      min: 0,
      default: 0,
    }),
    jsonPath: s.string({
      description:
        "For a JSON body, a dot path to show only that slice, e.g. \"response.messages.0\". " +
        "Cuts a huge body down to the field you want instead of paging.",
      optional: true,
    }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);
    const record = getRecord(tabId, args.requestId);
    if (!record) {
      // Distinguish "never recording" from "recorded but evicted"; guessing
      // eviction sent agents hunting for a buffer size they never set.
      const state = captureState(tabId);
      if (!state) {
        throw new PricklyError(
          `No capture is running on tab ${tabId}, so there are no requests to read. ` +
            `Start one with network_capture_start, then drive the page.`,
        );
      }
      throw new PricklyError(
        `No captured request ${args.requestId} on tab ${tabId}. ` +
          `The capture holds ${state.requests.length} request(s); list them with network_requests. ` +
          `If it was captured a while ago it may have been pushed out of the ring buffer.`,
      );
    }

    const summary = summarize(record, { redact: args.redact });
    const lines = [
      `${record.method} ${record.url}`,
      `status: ${summary.status ?? "(no response)"}  type: ${record.resourceType ?? "?"}  mime: ${record.mimeType ?? "?"}`,
      `duration: ${summary.durationMs ?? "?"}ms`,
      record.failed ? `failed: ${record.failed.errorText}${record.failed.canceled ? " (canceled)" : ""}` : "",
      "",
      "request headers:",
      ...Object.entries(summary.requestHeaders ?? {}).map(([k, v]) => `  ${k}: ${v}`),
    ].filter((l) => l !== "");

    if (record.postData) {
      lines.push("", `request body (${record.postData.length} chars):`, record.postData.slice(0, args.maxChars));
    }

    if (args.includeBody && record.body) {
      // A jsonPath slice beats paging for pulling one field out of a big body.
      let body = record.body;
      let sliceNote = "";
      if (args.jsonPath) {
        const sliced = sliceJsonPath(body, args.jsonPath);
        if (sliced === undefined) {
          sliceNote = ` (jsonPath "${args.jsonPath}" not found; showing whole body)`;
        } else {
          body = sliced;
          sliceNote = ` (sliced to ${args.jsonPath})`;
        }
      }
      const start = Math.min(args.bodyOffset, body.length);
      const shown = body.slice(start, start + args.maxChars);
      const end = start + shown.length;
      lines.push(
        "",
        `response body (${record.bodyEncoding}, ${body.length} chars${sliceNote}` +
          (record.bodyTruncated ? ", truncated at capture" : "") +
          (start > 0 || end < body.length ? `, showing ${start}-${end}` : "") +
          "):",
        shown,
        end < body.length ? `\n[${body.length - end} more chars; pass bodyOffset:${end} to continue]` : "",
      );
    } else if (args.includeBody && !record.body) {
      lines.push("", "(no body captured; it may have been evicted, or maxBodyBytes was 0)");
    }

    return { content: [{ type: "text", text: lines.filter((l) => l !== "").join("\n") }], meta: { summary } };
  },
});

// ---------------------------------------------------------------------------
// Interception
// ---------------------------------------------------------------------------

defineTool({
  name: "network_intercept",
  description:
    "Adds a rule that rewrites traffic as it happens: block a request, fail it with a chosen " +
    "error, serve a stubbed response, or modify headers and post data on the way out. Rules apply " +
    "to matching requests from that point on, so add them before triggering the traffic.",
  mutating: true,
  input: {
    action: s.enum_(["block", "fail", "fulfill", "continue"] as const, {
      description:
        "block/fail drop the request, fulfill answers it with a stub, continue lets it through (optionally modified).",
    }),
    urlContains: s.string({ description: "Case-insensitive substring match on the URL. Empty matches everything.", default: "" }),
    method: s.string({ description: "Only match this method.", optional: true }),
    tabId: s.number({ description: "Tab to install the rule on.", integer: true, optional: true }),
    errorReason: s.enum_(
      ["BlockedByClient", "Failed", "Aborted", "ConnectionFailed", "TimedOut", "NameNotResolved", "AccessDenied"] as const,
      { description: "For action fail.", optional: true },
    ),
    status: s.number({ description: "For action fulfill: status code.", integer: true, min: 100, max: 599, optional: true }),
    headers: s.record({ description: "For action fulfill: response headers.", optional: true }),
    body: s.string({ description: "For action fulfill: response body.", optional: true }),
    setRequestHeaders: s.record({ description: "For action continue: headers to set on the outgoing request.", optional: true }),
    setPostData: s.string({ description: "For action continue: replacement post data.", optional: true }),
    note: s.string({ description: "Shown in network_intercept_list, so you remember why the rule exists.", optional: true }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);

    // A capture owns the Fetch-domain lifetime; make sure one exists.
    await startCapture({ tabId });
    const rule = addRule(tabId, {
      urlContains: args.urlContains,
      method: args.method,
      action: args.action as InterceptAction,
      errorReason: args.errorReason,
      status: args.status,
      headers: args.headers,
      body: args.body,
      setRequestHeaders: args.setRequestHeaders,
      setPostData: args.setPostData,
      note: args.note,
    });
    await enableInterception(tabId);

    const target = rule.urlContains || "(all URLs)";
    return text(
      `Rule ${rule.id} installed: ${rule.action} ${rule.method ?? "any method"} matching "${target}".`,
      rule.note ? `Note: ${rule.note}` : "",
      `Matching requests will be handled as they arrive. List rules with network_intercept_list.`,
    );
  },
});

defineTool({
  name: "network_intercept_list",
  description: "Lists the interception rules on a tab, with hit counts.",
  batchable: true,
  input: {
    tabId: s.number({ description: "Tab.", integer: true, optional: true }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);
    const rules = listRules(tabId);
    if (!rules.length) return text(`No interception rules on tab ${tabId}.`);
    return text(
      ...rules.map(
        (r) =>
          `${r.id} ${r.action.padEnd(8)} ${r.method ?? "*"} "${r.urlContains || "*"}" hits=${r.hits}` +
          (r.note ? ` — ${r.note}` : ""),
      ),
    );
  },
});

defineTool({
  name: "network_intercept_remove",
  description: "Removes an interception rule. Removing the last one turns interception off.",
  mutating: true,
  input: {
    ruleId: s.string({ description: "From network_intercept_list." }),
    tabId: s.number({ description: "Tab.", integer: true, optional: true }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);
    const removed = removeRule(tabId, args.ruleId);
    if (!removed) throw new PricklyError(`No rule ${args.ruleId} on tab ${tabId}.`);
    if (!listRules(tabId).length) {
      await disableInterception(tabId).catch(() => {});
      return text(`Removed ${args.ruleId}. No rules left, so interception is off.`);
    }
    return text(`Removed ${args.ruleId}.`);
  },
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

defineTool({
  name: "network_replay",
  description:
    "Re-issues a captured request from inside the page, so it carries the page's cookies and " +
    "origin exactly as the original did. Override method, URL, headers, or body to fuzz it. The " +
    "replay is itself recorded, so a chain of them stays visible.",
  mutating: true,
  input: {
    requestId: s.string({ description: "A captured request to base the replay on." }),
    tabId: s.number({ description: "Tab to replay from.", integer: true, optional: true }),
    method: s.string({ description: "Override the method.", optional: true }),
    url: s.string({ description: "Override the URL.", optional: true }),
    headers: s.record({ description: "Headers to add or replace.", optional: true }),
    body: s.string({ description: "Replacement request body.", optional: true }),
    withoutCredentials: s.boolean({ description: "Drop the Cookie header, to replay unauthenticated.", default: false }),
    redact: s.boolean({
      description: "Mask credential-looking response headers. Off by default; set true to hide them.",
      default: false,
    }),
    maxChars: s.number({ description: "Response body truncation.", integer: true, min: 500, max: MAX_BODY_CHARS, default: 20_000 }),
  },
  async execute(args, ctx) {
    const tabId = await tabIdFor(ctx, args.tabId);
    const result = await replay(tabId, args);

    const headers = args.redact
      ? Object.fromEntries(
          Object.entries(result.headers).map(([k, v]) => [k, /auth|token|cookie|secret/i.test(k) ? "[redacted]" : v]),
        )
      : result.headers;

    const body = result.body.slice(0, args.maxChars);
    const dropped = result.droppedHeaders?.length
      ? [
          "",
          `note: ${result.droppedHeaders.length} header(s) the browser forbids scripts from ` +
            `setting were dropped (${result.droppedHeaders.join(", ")}). Auth headers are not ` +
            `among them, so the replay stays authenticated.`,
        ]
      : [];

    return {
      content: [
        {
          type: "text",
          text: [
            `${args.method ?? ""} replay of ${args.requestId} -> ${result.status} ${result.statusText} in ${result.durationMs}ms`,
            ...dropped,
            "",
            "response headers:",
            ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`),
            "",
            `response body (${result.body.length} chars${result.truncated ? ", truncated at capture" : ""}):`,
            body,
          ].join("\n"),
        },
      ],
      meta: { status: result.status, durationMs: result.durationMs, droppedHeaders: result.droppedHeaders },
    };
  },
});
