/**
 * Prickly wire protocol.
 *
 * Two hops speak this, both with identical framing:
 *
 *   agent  --unix socket-->  host  --stdio native messaging-->  extension
 *
 * Framing is Chrome native-messaging style: a 4-byte little-endian length
 * prefix followed by UTF-8 JSON. Chrome imposes the format on the stdio hop,
 * so we reuse it on the socket hop rather than inventing a second one.
 *
 * Unlike the protocol this is modelled on, every request carries an `id`.
 * Without one the channel is serialized to a single in-flight call per
 * browser, which is invisible until two agent sessions race.
 */

export const PROTOCOL_VERSION = 1;

/** Max frame size. Screenshots are the only thing that gets close. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface Request<P = unknown> {
  kind: "request";
  id: string;
  method: string;
  params: P;
}

export interface Response<R = unknown> {
  kind: "response";
  id: string;
  result?: R;
  error?: ProtocolError;
}

/**
 * Unsolicited extension -> host traffic: console lines, network events,
 * a browser going away. Never awaited, safe to drop.
 */
export interface Event<P = unknown> {
  kind: "event";
  event: string;
  params: P;
}

export type Frame = Request | Response | Event;

export interface ProtocolError {
  message: string;
  /** Machine-readable discriminator so callers can branch without regex. */
  code?: ErrorCode;
  data?: unknown;
}

export type ErrorCode =
  | "unknown_method"
  | "unknown_tool"
  | "bad_params"
  | "no_such_tab"
  | "tab_not_in_session"
  | "no_such_session"
  | "no_such_browser"
  | "attach_failed"
  | "restricted_url"
  | "blocked_url"
  | "navigated_away"
  | "timeout"
  | "internal";

export class PricklyError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = "internal",
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "PricklyError";
  }

  toProtocol(): ProtocolError {
    return { message: this.message, code: this.code, data: this.data };
  }
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export interface Methods {
  /** Identity handshake. Sent host -> extension on connect. */
  hello: { params: HelloParams; result: BrowserIdentity };
  /** Liveness. Either direction. */
  ping: { params: Record<string, never>; result: { pong: true } };
  /** Tool schemas, generated from the live registry rather than hardcoded. */
  "tools/list": { params: Record<string, never>; result: { tools: ToolSchema[] } };
  "tools/call": { params: ToolCallParams; result: ToolResult };
}

export interface HelloParams {
  protocolVersion: number;
  /** Free-form label for logs: "crush", "claude-code", "probe". */
  client: string;
}

/**
 * One browser profile. Chrome spawns a separate native host process per
 * profile, so a person running Dia and Chrome with two profiles each has four
 * of these, and the agent picks between them.
 */
export interface BrowserIdentity {
  /** Stable across restarts. Generated once and kept in chrome.storage.local. */
  browserId: string;
  /** "Dia", "Google Chrome", "Brave Browser". Read from the user agent. */
  browser: string;
  browserVersion: string;
  /** User-facing profile label, editable from the extension options page. */
  profile: string;
  extensionId: string;
  platform: string;
  protocolVersion: number;
}

export interface ToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Scopes the call to one agent session's tab group. Omit and the tool
   * operates on a default session keyed by client id.
   */
  session?: SessionRef;
}

export interface SessionRef {
  sessionId: string;
  tabGroupId?: number;
}

// ---------------------------------------------------------------------------
// Tool results (MCP content blocks, so the host can pass them straight through)
// ---------------------------------------------------------------------------

export type ContentBlock = TextBlock | ImageBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  /**
   * Out-of-band data the agent does not need in its context but the host
   * might: screenshot dimensions, capture ids, timing.
   */
  meta?: Record<string, unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  /** Tools safe to run inside browser_batch. */
  batchable?: boolean;
  /** Tools that mutate page state, and so get the TOCTOU origin guard. */
  mutating?: boolean;
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface Events {
  /** Extension is going away (browser quit, extension reload). */
  goodbye: { reason: string };
  /** A capture rule matched. Only sent when the agent asked to stream. */
  "network/request": NetworkEventPayload;
  log: { level: "debug" | "info" | "warn" | "error"; message: string };
}

export interface NetworkEventPayload {
  captureId: string;
  requestId: string;
  phase: "request" | "response" | "failed";
  url: string;
  method?: string;
  status?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function text(...parts: string[]): ToolResult {
  return { content: [{ type: "text", text: parts.join("\n") }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function isRequest(f: Frame): f is Request {
  return f.kind === "request";
}

export function isResponse(f: Frame): f is Response {
  return f.kind === "response";
}

export function isEvent(f: Frame): f is Event {
  return f.kind === "event";
}

let counter = 0;
export function nextId(prefix = "r"): string {
  counter = (counter + 1) % 0xffffff;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}
