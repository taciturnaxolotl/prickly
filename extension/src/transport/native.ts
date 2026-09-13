/**
 * Native messaging transport.
 *
 * Chrome does the length-prefix framing for us on this hop: sendNativeMessage
 * and Port.postMessage take a JSON object and Chrome writes the 4-byte header.
 * So this file is about correlation, not framing.
 *
 * Requests are answered by id, which means several agent sessions can have
 * calls in flight against one browser at once. The upstream design has no id
 * here and pays for it with a hard one-call-at-a-time ceiling.
 */

import {
  PricklyError,
  nextId,
  type BrowserIdentity,
  type Event as ProtocolEvent,
  type Frame,
  type Request,
  type Response,
} from "@shared/protocol";

export const NATIVE_HOST_NAME = "sh.dunkirk.prickly";

const DEFAULT_TIMEOUT_MS = 120_000;

type Handler = (params: unknown) => Promise<unknown>;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class NativeConnection {
  private port: chrome.runtime.Port | null = null;
  private handlers = new Map<string, Handler>();
  private pending = new Map<string, Pending>();
  private connected = false;
  private client = "unknown";
  private browserId = "";

  /** Outbound events are dropped when disconnected; nothing depends on them. */
  private outbox: ProtocolEvent[] = [];

  constructor(private readonly onStatus: (connected: boolean) => void) {}

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  status(): { connected: boolean; host: string; client: string; browserId: string } {
    return {
      connected: this.connected,
      host: NATIVE_HOST_NAME,
      client: this.client,
      browserId: this.browserId,
    };
  }

  async connect(identityPromise: Promise<BrowserIdentity>): Promise<boolean> {
    if (this.connected) return true;
    if (!chrome.runtime.connectNative) {
      // nativeMessaging permission missing or unsupported. Nothing to do.
      return false;
    }

    const identity = await identityPromise;
    this.browserId = identity.browserId;

    return new Promise((resolve) => {
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      } catch (err) {
        console.warn("[prickly] connectNative threw", err);
        resolve(false);
        return;
      }
      this.port = port;

      const fail = (): void => {
        this.connected = false;
        this.port = null;
        this.rejectAllPending("native host connection closed");
        this.onStatus(false);
        resolve(false);
      };

      port.onMessage.addListener((message) => this.receive(message as Frame));
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        if (err) console.warn("[prickly] native host disconnected:", err.message);
        fail();
      });

      // Announce ourselves. The host uses this to write its socket descriptor,
      // which is how an agent learns this browser exists.
      this.connected = true;
      this.onStatus(true);
      this.send({
        kind: "request",
        id: nextId("hello"),
        method: "register",
        params: { identity },
      });
      this.flushOutbox();
      resolve(true);
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new PricklyError(reason, "internal"));
      this.pending.delete(id);
    }
  }

  private send(frame: Frame): void {
    if (!this.port || !this.connected) return;
    try {
      this.port.postMessage(frame);
    } catch (err) {
      console.error("[prickly] failed to write frame", err);
      this.connected = false;
    }
  }

  /** Fire-and-forget. Events are advisory and never retried. */
  sendEvent(event: string, params: unknown): void {
    const frame: ProtocolEvent = { kind: "event", event, params };
    if (!this.connected) {
      // Bounded so a long disconnect does not grow the heap.
      if (this.outbox.length < 200) this.outbox.push(frame);
      return;
    }
    this.send(frame);
  }

  private flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const frame of queued) this.send(frame);
  }

  /** Host -> extension requests (ping, register ack, and nothing else today). */
  private receive(frame: Frame): void {
    if (frame.kind === "request") {
      void this.handleRequest(frame);
      return;
    }
    if (frame.kind === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        pending.reject(new PricklyError(frame.error.message, frame.error.code ?? "internal"));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame.kind === "event") {
      // Extension does not consume events today; the host does.
      return;
    }
  }

  private async handleRequest(frame: Request): Promise<void> {
    const handler = this.handlers.get(frame.method);
    if (!handler) {
      this.send({
        kind: "response",
        id: frame.id,
        error: { message: `Unknown method: ${frame.method}`, code: "unknown_method" },
      } satisfies Response);
      return;
    }

    if (frame.method === "hello") {
      const params = frame.params as { client?: string };
      if (params?.client) this.client = params.client;
    }

    try {
      const result = await handler(frame.params);
      this.send({ kind: "response", id: frame.id, result });
    } catch (err) {
      const protocolError =
        err instanceof PricklyError
          ? err.toProtocol()
          : { message: String((err as Error)?.message ?? err), code: "internal" as const };
      this.send({ kind: "response", id: frame.id, error: protocolError });
    }
  }

  /** Extension -> host requests. */
  request<T>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.connected) {
      return Promise.reject(new PricklyError("native host is not connected", "internal"));
    }
    const id = nextId("req");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PricklyError(`${method} timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ kind: "request", id, method, params });
    });
  }

  disconnect(): void {
    this.sendEvent("goodbye", { reason: "disconnect" });
    this.port?.disconnect();
    this.port = null;
    this.connected = false;
    this.rejectAllPending("disconnected");
    this.onStatus(false);
  }
}

let connection: NativeConnection | null = null;

export function initNativeTransport(
  identityPromise: Promise<BrowserIdentity>,
  onStatus: (connected: boolean) => void,
): NativeConnection {
  connection ??= new NativeConnection(onStatus);
  void connection.connect(identityPromise);
  return connection;
}

export function transport(): NativeConnection | null {
  return connection;
}

export function sendEvent(event: string, params: unknown): void {
  connection?.sendEvent(event, params);
}
