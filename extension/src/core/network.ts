/**
 * Network capture, interception, and replay.
 *
 * This is the part worth building for security research. Three things, all
 * on CDP so they see the same traffic DevTools sees:
 *
 *   capture      Network domain, ring buffer per tab, bodies fetched eagerly
 *   intercept    Fetch domain, with rules that block, fail, rewrite, or stub
 *   replay       re-issue a captured request from the page origin, so cookies
 *                and CORS behave like the original
 *
 * A capture that pins the session attached is deliberate: the buffer is only
 * useful across tool calls, so it has to survive the idle detach.
 */

import { PricklyError } from "@shared/protocol";
import { cdp, sleep } from "./cdp";
import { redactHeaders, isSensitiveKey } from "./guards";
import { sendEvent } from "../transport/native";

export interface CapturedRequest {
  requestId: string;
  captureId: string;
  tabId: number;
  url: string;
  method: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  /** Truncated at postBodyLimit. */
  postData?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  body?: string;
  bodyEncoding?: "utf8" | "base64";
  bodyTruncated?: boolean;
  failed?: { errorText: string; canceled: boolean };
  timing: { startedAt: number; endedAt?: number };
}

export type InterceptAction = "continue" | "block" | "fail" | "fulfill";

export interface InterceptRule {
  id: string;
  /** Substring match on URL. Empty means everything. */
  urlContains: string;
  method?: string;
  action: InterceptAction;
  /** For action "fail". */
  errorReason?: string;
  /** For action "fulfill". */
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** For action "continue": rewrite these before sending. */
  setRequestHeaders?: Record<string, string>;
  setPostData?: string;
  note?: string;
  hits: number;
  createdAt: number;
}

export interface CaptureOptions {
  tabId: number;
  captureId?: string;
  /** Ring buffer size. */
  max?: number;
  /** Store response bodies up to this many bytes. 0 disables bodies. */
  maxBodyBytes?: number;
  /** Stream matched requests to the host as events. */
  stream?: boolean;
}

const DEFAULT_MAX = 500;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

interface TabState {
  captureId: string;
  max: number;
  maxBodyBytes: number;
  stream: boolean;
  requests: CapturedRequest[];
  byRequestId: Map<string, CapturedRequest>;
  rules: InterceptRule[];
  /** requestId -> the intercepted call, so a rule can be timed out. */
  pending: Map<string, () => void>;
  startedAt: number;
}

const state = new Map<number, TabState>();
let ruleCounter = 0;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export function captureState(tabId: number): TabState | undefined {
  return state.get(tabId);
}

function ensure(tabId: number, opts: CaptureOptions): TabState {
  let existing = state.get(tabId);
  if (!existing) {
    existing = {
      captureId: opts.captureId ?? `cap_${Date.now().toString(36)}`,
      max: opts.max ?? DEFAULT_MAX,
      maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      stream: opts.stream ?? false,
      requests: [],
      byRequestId: new Map(),
      rules: [],
      pending: new Map(),
      startedAt: Date.now(),
    };
    state.set(tabId, existing);
  }
  return existing;
}

export async function startCapture(opts: CaptureOptions): Promise<TabState> {
  const existing = ensure(opts.tabId, opts);
  // Allow re-configuring a live capture without losing the buffer.
  if (opts.max !== undefined) existing.max = opts.max;
  if (opts.maxBodyBytes !== undefined) existing.maxBodyBytes = opts.maxBodyBytes;
  if (opts.stream !== undefined) existing.stream = opts.stream;
  if (opts.captureId) existing.captureId = opts.captureId;

  const session = cdp(opts.tabId);
  await session.enable("Network", { maxPostDataSize: 65_536 });
  return existing;
}

export function clearCapture(tabId: number): number {
  const s = state.get(tabId);
  if (!s) return 0;
  const count = s.requests.length;
  s.requests = [];
  s.byRequestId.clear();
  return count;
}

export async function stopCapture(tabId: number): Promise<number> {
  const s = state.get(tabId);
  if (!s) return 0;
  const count = s.requests.length;
  await cdp(tabId).disable("Network").catch(() => {});
  state.delete(tabId);
  return count;
}

/** Drop everything for a tab that went away. */
export function forget(tabId: number): void {
  state.delete(tabId);
}

interface RequestWillBeSent {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  type?: string;
  timestamp: number;
}

interface ResponseReceived {
  requestId: string;
  response: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
  };
  type?: string;
}

interface LoadingFailed {
  requestId: string;
  errorText: string;
  canceled: boolean;
}

/**
 * Called once, from the global CDP event fan-out.
 */
export async function handleNetworkEvent(
  tabId: number,
  method: string,
  params: unknown,
): Promise<void> {
  const s = state.get(tabId);
  if (!s) return;

  if (method === "Network.requestWillBeSent") {
    const e = params as RequestWillBeSent;
    const record: CapturedRequest = {
      requestId: e.requestId,
      captureId: s.captureId,
      tabId,
      url: e.request.url,
      method: e.request.method,
      resourceType: e.type,
      requestHeaders: e.request.headers,
      postData: e.request.postData?.slice(0, s.maxBodyBytes),
      timing: { startedAt: Date.now() },
    };
    push(s, record);
    if (s.stream) {
      sendEvent("network/request", {
        captureId: s.captureId,
        requestId: e.requestId,
        phase: "request",
        url: record.url,
        method: record.method,
      });
    }
    return;
  }

  if (method === "Network.responseReceived") {
    const e = params as ResponseReceived;
    const record = s.byRequestId.get(e.requestId);
    if (!record) return;
    record.status = e.response.status;
    record.statusText = e.response.statusText;
    record.responseHeaders = e.response.headers;
    record.mimeType = e.response.mimeType;
    record.timing.endedAt = Date.now();
    if (s.stream) {
      sendEvent("network/request", {
        captureId: s.captureId,
        requestId: e.requestId,
        phase: "response",
        url: record.url,
        status: record.status,
      });
    }
    // getResponseBody is only reliable while the request is still live in
    // Chrome's network stack, so fetch it now rather than on demand later.
    if (s.maxBodyBytes > 0) await fetchBody(tabId, record, s.maxBodyBytes);
    return;
  }

  if (method === "Network.loadingFailed") {
    const e = params as LoadingFailed;
    const record = s.byRequestId.get(e.requestId);
    if (!record) return;
    record.failed = { errorText: e.errorText, canceled: e.canceled };
    record.timing.endedAt = Date.now();
    if (s.stream) {
      sendEvent("network/request", {
        captureId: s.captureId,
        requestId: e.requestId,
        phase: "failed",
        url: record.url,
      });
    }
  }
}

async function fetchBody(
  tabId: number,
  record: CapturedRequest,
  maxBytes: number,
): Promise<void> {
  // Binary types are the interesting ones for RE work, so keep them.
  try {
    const body = await cdp(tabId).send<{ body: string; base64Encoded: boolean }>(
      "Network.getResponseBody",
      { requestId: record.requestId },
    );
    const text = body.base64Encoded ? atob(body.body).length > maxBytes
      ? body.body.slice(0, Math.ceil((maxBytes / 3) * 4))
      : body.body : body.body;
    record.body = text;
    record.bodyEncoding = body.base64Encoded ? "base64" : "utf8";
    record.bodyTruncated = text.length !== body.body.length;
  } catch {
    // Body evicted, or a redirect with no response. Not an error.
  }
}

function push(s: TabState, record: CapturedRequest): void {
  s.requests.push(record);
  s.byRequestId.set(record.requestId, record);
  while (s.requests.length > s.max) {
    const dropped = s.requests.shift();
    if (dropped) s.byRequestId.delete(dropped.requestId);
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface QueryOptions {
  urlPattern?: string;
  method?: string;
  resourceType?: string;
  statusMin?: number;
  statusMax?: number;
  /** Only requests whose response body contains this. */
  bodyContains?: string;
  since?: number;
  limit?: number;
}

export function query(tabId: number, opts: QueryOptions = {}): CapturedRequest[] {
  const s = state.get(tabId);
  if (!s) return [];
  let out = s.requests;

  if (opts.since) out = out.filter((r) => r.timing.startedAt >= opts.since!);
  if (opts.method) {
    const m = opts.method.toUpperCase();
    out = out.filter((r) => r.method === m);
  }
  if (opts.resourceType) out = out.filter((r) => r.resourceType === opts.resourceType);
  if (opts.statusMin !== undefined) out = out.filter((r) => (r.status ?? 0) >= opts.statusMin!);
  if (opts.statusMax !== undefined) out = out.filter((r) => (r.status ?? 0) <= opts.statusMax!);
  if (opts.urlPattern) {
    const re = toRegExp(opts.urlPattern);
    out = out.filter((r) => re.test(r.url));
  }
  if (opts.bodyContains) {
    const needle = opts.bodyContains.toLowerCase();
    out = out.filter((r) => r.body?.toLowerCase().includes(needle));
  }
  if (opts.limit) out = out.slice(-opts.limit);
  return out;
}

/** Plain substring by default; `/re/flags` opts into a regex. */
function toRegExp(pattern: string): RegExp {
  const m = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
  if (m) {
    const source = m[1] ?? "";
    const flags = m[2] ?? "";
    try {
      return new RegExp(source, flags);
    } catch {
      // Fall through to literal.
    }
  }
  return new RegExp(escapeRegExp(pattern), "i");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One request, with headers redacted for the agent's context. */
export function summarize(record: CapturedRequest, options: { redact?: boolean } = {}) {
  const redactIt = options.redact !== false;
  return {
    requestId: record.requestId,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
    status: record.status,
    mimeType: record.mimeType,
    requestHeaders: redactIt ? redactHeaders(record.requestHeaders) : record.requestHeaders,
    responseHeaders: redactIt ? redactHeaders(record.responseHeaders) : record.responseHeaders,
    postDataLength: record.postData?.length,
    bodyLength: record.body?.length,
    bodyEncoding: record.bodyEncoding,
    failed: record.failed,
    durationMs: record.timing.endedAt
      ? record.timing.endedAt - record.timing.startedAt
      : undefined,
  };
}

export function getRecord(tabId: number, requestId: string): CapturedRequest | undefined {
  return state.get(tabId)?.byRequestId.get(requestId);
}

// ---------------------------------------------------------------------------
// Interception
// ---------------------------------------------------------------------------

export function addRule(tabId: number, rule: Omit<InterceptRule, "id" | "hits" | "createdAt">): InterceptRule {
  const s = state.get(tabId);
  if (!s) throw new PricklyError("No capture is running on this tab. Start one first.");
  const full: InterceptRule = {
    ...rule,
    id: `rule_${++ruleCounter}`,
    hits: 0,
    createdAt: Date.now(),
  };
  s.rules.push(full);
  return full;
}

export function removeRule(tabId: number, ruleId: string): boolean {
  const s = state.get(tabId);
  if (!s) return false;
  const before = s.rules.length;
  s.rules = s.rules.filter((r) => r.id !== ruleId);
  return s.rules.length !== before;
}

export function listRules(tabId: number): InterceptRule[] {
  return state.get(tabId)?.rules ?? [];
}

export async function enableInterception(tabId: number): Promise<void> {
  const session = cdp(tabId);
  await session.enable("Fetch");
  await session.send("Fetch.enable", { handleAuthRequests: false });
}

export async function disableInterception(tabId: number): Promise<void> {
  const s = state.get(tabId);
  if (!s) return;
  s.rules = [];
  for (const resolve of s.pending.values()) resolve();
  s.pending.clear();
  await cdp(tabId).disable("Fetch").catch(() => {});
}

interface RequestPaused {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  responseStatusCode?: number;
  responseHeaders?: { name: string; value: string }[];
  networkId: string;
  /** Present when paused on the response phase. */
  responseErrorReason?: string;
}

/**
 * Called from the global CDP event fan-out when Fetch.requestPaused lands.
 *
 * Pausing a request holds the page's network stack open, so a rule that hangs
 * would freeze the tab. Every branch resolves, and there is a 5s ceiling.
 */
export async function handleRequestPaused(tabId: number, params: unknown): Promise<void> {
  const s = state.get(tabId);
  const e = params as RequestPaused;
  const session = cdp(tabId);

  const rule = s?.rules.find((r) => matches(r, e.request.url, e.request.method));
  if (rule) rule.hits++;

  // No rule for the response phase means pass through untouched.
  const isResponse = e.responseStatusCode !== undefined || e.responseErrorReason !== undefined;

  const settle = async (fn: () => Promise<void>): Promise<void> => {
    const timeout = sleep(5000);
    await Promise.race([fn().catch((err) => {
      console.error("[prickly] interception failed", err);
      void continueRequest(tabId, e.requestId).catch(() => {});
    }), timeout]);
  };

  if (!rule || rule.action === "continue") {
    const headers = rule?.setRequestHeaders;
    const postData = rule?.setPostData;
    if (headers && !isResponse) {
      const merged = { ...e.request.headers, ...headers };
      await settle(() =>
        session
          .send("Fetch.continueRequest", {
            requestId: e.requestId,
            headers: toHeaderPairs(merged),
            ...(postData !== undefined ? { postData: btoa(unescape(encodeURIComponent(postData))) } : {}),
          })
          .then(() => {}),
      );
      return;
    }
    await settle(() => continueRequest(tabId, e.requestId));
    return;
  }

  if (rule.action === "block" || rule.action === "fail") {
    await settle(() =>
      session
        .send("Fetch.failRequest", {
          requestId: e.requestId,
          errorReason: rule.errorReason ?? "BlockedByClient",
        })
        .then(() => {}),
    );
    return;
  }

  if (rule.action === "fulfill") {
    await settle(() =>
      session
        .send("Fetch.fulfillRequest", {
          requestId: e.requestId,
          responseCode: rule.status ?? 200,
          responseHeaders: toHeaderPairs(rule.headers ?? { "content-type": "application/json" }),
          body: rule.body !== undefined
            ? btoa(unescape(encodeURIComponent(rule.body)))
            : "",
        })
        .then(() => {}),
    );
    return;
  }
}

function matches(rule: InterceptRule, url: string, method: string): boolean {
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  if (!rule.urlContains) return true;
  return url.toLowerCase().includes(rule.urlContains.toLowerCase());
}

async function continueRequest(tabId: number, requestId: string): Promise<void> {
  await cdp(tabId).send("Fetch.continueRequest", { requestId });
}

function toHeaderPairs(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Headers fetch() refuses to let script set. Trying to set any one of them
 * fails the whole request with a bare "Failed to fetch", so they are stripped
 * before a replay. The Sec-* and Proxy-* families are prefix-matched.
 *
 * https://fetch.spec.whatwg.org/#forbidden-request-header
 */
const FORBIDDEN_HEADERS = new Set(
  [
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie2",
    "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "te",
    "trailer", "transfer-encoding", "upgrade", "via", "user-agent",
  ].map((h) => h.toLowerCase()),
);

function isForbiddenRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lower)) return true;
  return lower.startsWith("sec-") || lower.startsWith("proxy-");
}

export interface ReplayOptions {
  requestId: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Drop the Cookie header, to replay unauthenticated. */
  withoutCredentials?: boolean;
}

export interface ReplayResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  durationMs: number;
  /** Auth-irrelevant headers fetch() would not let us set, so the caller knows. */
  droppedHeaders?: string[];
}

/**
 * Re-issues a captured request.
 *
 * From the service worker, not the page. The page context enforces CORS, so a
 * page-side fetch to any origin other than the tab's own throws "Failed to
 * fetch" before it leaves the browser, and cross-origin API calls are exactly
 * what a research replay is for. The service worker holds host_permissions for
 * every URL, which exempts it from CORS while still attaching the domain's
 * cookies.
 *
 * The cost is that the request carries the extension's origin rather than the
 * page's, and cannot set the forbidden headers (User-Agent, Referer, the
 * Sec-* family). For token- or cookie-authenticated APIs, which is nearly all
 * of them, none of that matters: the auth travels in x-access-token,
 * Authorization, or Cookie, and those all survive.
 */
export async function replay(tabId: number, opts: ReplayOptions): Promise<ReplayResult> {
  const record = getRecord(tabId, opts.requestId);
  if (!record) {
    throw new PricklyError(
      `No captured request with id ${opts.requestId}. List the capture to find it.`,
    );
  }

  const headers: Record<string, string> = { ...record.requestHeaders, ...opts.headers };
  if (opts.withoutCredentials) {
    delete headers["Cookie"];
    delete headers["cookie"];
  }
  // fetch() throws for the whole request if you set a forbidden header, and a
  // captured browser request carries several. Auth headers are not forbidden,
  // so stripping these keeps the replay authenticated.
  for (const name of Object.keys(headers)) {
    if (isForbiddenRequestHeader(name)) delete headers[name];
  }

  const method = opts.method ?? record.method;
  const url = opts.url ?? record.url;
  const body = opts.body ?? (method === "GET" || method === "HEAD" ? undefined : record.postData);
  const dropped = Object.keys(record.requestHeaders).filter(isForbiddenRequestHeader);

  const startedAt = performance.now();
  let result: ReplayResult;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      // The service worker is not tied to a document, so cookies come from the
      // browser's jar for the target domain rather than from the page.
      credentials: opts.withoutCredentials ? "omit" : "include",
      redirect: "follow",
    });
    const text = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    result = {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      body: text.slice(0, 512 * 1024),
      truncated: text.length > 512 * 1024,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (err) {
    result = {
      ok: false,
      status: 0,
      statusText: "",
      headers: {},
      body: `Replay failed: ${String((err as Error)?.message ?? err)}`,
      truncated: false,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
  if (dropped.length) result.droppedHeaders = dropped;

  // A replay is itself traffic. Record it so a chain of replays is visible
  // rather than vanishing.
  const replayRecord: CapturedRequest = {
    requestId: `replay_${Date.now().toString(36)}`,
    captureId: record.captureId,
    tabId,
    url,
    method,
    requestHeaders: headers,
    postData: body,
    status: result.status,
    statusText: result.statusText,
    responseHeaders: result.headers,
    body: result.body,
    bodyEncoding: "utf8",
    bodyTruncated: result.truncated,
    timing: { startedAt: Date.now() - result.durationMs, endedAt: Date.now() },
  };
  const s = state.get(tabId);
  if (s) push(s, replayRecord);

  return result;
}

/** Names of headers that look like they hold secrets. */
export function sensitiveHeaderNames(headers: Record<string, string> = {}): string[] {
  return Object.keys(headers).filter(isSensitiveKey);
}
