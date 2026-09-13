/**
 * Host side of the wire.
 *
 * Two roles live here because they share everything but the direction:
 *
 *   ExtensionPeer  the native-messaging end, talking to one browser
 *   BrowserClient  the socket end, talking to one agent process
 *
 * The bridge between them is a pending-request map keyed by id, which is what
 * lets several agent sessions share one browser. Upstream has no id on this
 * channel and so has a hard one-call-at-a-time ceiling; adding one is the
 * single highest-value change in the whole design.
 */

import { connect, listen, type Socket, type UnixSocketListener } from "bun";
import { rmSync } from "node:fs";
import { FrameDecoder, encodeFrame } from "../../shared/framing";
import {
  PricklyError,
  nextId,
  type Event as ProtocolEvent,
  type Frame,
  type Request,
  type Response,
  type ToolResult,
  type ToolSchema,
} from "../../shared/protocol";

const DEFAULT_TIMEOUT_MS = 120_000;

type MethodHandler = (params: unknown) => Promise<unknown>;

class Pending {
  private map = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  add(id: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        reject(new PricklyError(`request ${id} timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      this.map.set(id, { resolve, reject, timer });
    });
  }

  settle(frame: Response): boolean {
    const entry = this.map.get(frame.id);
    if (!entry) return false;
    this.map.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) {
      entry.reject(new PricklyError(frame.error.message, frame.error.code ?? "internal", frame.error.data));
    } else {
      entry.resolve(frame.result);
    }
    return true;
  }

  rejectAll(reason: string): void {
    for (const [, entry] of this.map) {
      clearTimeout(entry.timer);
      entry.reject(new PricklyError(reason, "internal"));
    }
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Extension peer (native messaging side)
// ---------------------------------------------------------------------------

export interface ExtensionPeerOptions {
  /** Where frames arrive from Chrome's stdin. */
  input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  /** Where frames go back to Chrome. */
  write(bytes: Uint8Array): void;
  onClose(reason: string): void;
}

export class ExtensionPeer {
  private decoder = new FrameDecoder();
  private pending = new Pending();
  private handlers = new Map<string, MethodHandler>();
  private onEvent: (event: ProtocolEvent) => void = () => {};

  constructor(private readonly opts: ExtensionPeerOptions) {}

  handle(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  events(handler: (event: ProtocolEvent) => void): void {
    this.onEvent = handler;
  }

  send(frame: Frame): void {
    try {
      this.opts.write(encodeFrame(frame));
    } catch (err) {
      console.error("[prickly-host] write to extension failed", err);
    }
  }

  /** Feed raw bytes off stdin. */
  feed(chunk: Uint8Array): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      console.error("[prickly-host] framing error", err);
      return;
    }
    for (const frame of frames) this.receive(frame);
  }

  private receive(frame: Frame): void {
    if (frame.kind === "response") {
      if (!this.pending.settle(frame)) {
        console.warn(`[prickly-host] response for unknown id ${frame.id}`);
      }
      return;
    }
    if (frame.kind === "event") {
      this.onEvent(frame);
      return;
    }
    if (frame.kind === "request") {
      void this.answer(frame);
    }
  }

  private async answer(frame: Request): Promise<void> {
    const handler = this.handlers.get(frame.method);
    if (!handler) {
      this.send({
        kind: "response",
        id: frame.id,
        error: { message: `Unknown method: ${frame.method}`, code: "unknown_method" },
      });
      return;
    }
    try {
      const result = await handler(frame.params);
      this.send({ kind: "response", id: frame.id, result });
    } catch (err) {
      const error =
        err instanceof PricklyError
          ? err.toProtocol()
          : { message: String((err as Error)?.message ?? err), code: "internal" as const };
      this.send({ kind: "response", id: frame.id, error });
    }
  }

  request<T>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = nextId("h");
    const promise = this.pending.add(id, timeoutMs) as Promise<T>;
    this.send({ kind: "request", id, method, params });
    return promise;
  }

  close(reason: string): void {
    this.pending.rejectAll(reason);
  }
}

// ---------------------------------------------------------------------------
// Browser client (socket side, used by the MCP server)
// ---------------------------------------------------------------------------

export interface BrowserClientEvents {
  onEvent?(event: ProtocolEvent): void;
  onClose?(reason: string): void;
}

/**
 * Bun sockets take as much as the kernel buffer will hold and return the byte
 * count; anything past that is the caller's problem. Ignoring the return value
 * silently truncates every frame larger than the socket buffer, which desyncs
 * a length-prefixed stream permanently: the header promises N bytes, fewer
 * arrive, and the decoder either waits forever or parses the next frame's
 * bytes as the tail of this one.
 *
 * Small frames always fit, so this stays invisible until the first big one.
 */
class SocketWriter {
  private queue: Uint8Array[] = [];

  write(socket: { write(b: Uint8Array): number }, bytes: Uint8Array): void {
    // Once anything is queued, everything queues, or frames would interleave.
    if (this.queue.length > 0) {
      this.queue.push(bytes);
      return;
    }
    const written = socket.write(bytes);
    if (written < bytes.length) this.queue.push(bytes.subarray(written));
  }

  /** Called from the socket's drain event. */
  flush(socket: { write(b: Uint8Array): number }): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      const written = socket.write(head);
      if (written < head.length) {
        this.queue[0] = head.subarray(written);
        return;
      }
      this.queue.shift();
    }
  }

  get backlog(): number {
    return this.queue.length;
  }
}

/** Per-connection state we hang off Bun's socket data slot. */
interface ClientSocketData {
  client: BrowserClient;
}

interface ServerSocketData {
  decoder?: FrameDecoder;
  writer?: SocketWriter;
  /** Sessions this client touched, so they can be cleaned up when it drops. */
  sessions?: Set<string>;
}

export class BrowserClient {
  private socket: Socket<ClientSocketData> | null = null;
  private decoder = new FrameDecoder();
  private writer = new SocketWriter();
  private pending = new Pending();
  private closed = false;

  constructor(
    readonly path: string,
    private readonly handlers: BrowserClientEvents = {},
  ) {}

  async connect(): Promise<void> {
    this.socket = await connect<ClientSocketData>({
      unix: this.path,
      data: { client: this },
      socket: {
        data: (socket: Socket<ClientSocketData>, chunk: Uint8Array) => {
          let frames: Frame[];
          try {
            frames = this.decoder.push(chunk);
          } catch (err) {
            console.error("[prickly] framing error from browser", err);
            this.close("framing error");
            return;
          }
          for (const frame of frames) {
            if (frame.kind === "response") {
              if (!this.pending.settle(frame)) console.warn(`[prickly] orphan response ${frame.id}`);
            } else if (frame.kind === "event") {
              this.handlers.onEvent?.(frame);
            } else if (frame.kind === "request") {
              // The browser never requests from a client today, but answer
              // politely rather than leaving it hanging.
              this.writer.write(
                socket,
                encodeFrame({
                  kind: "response",
                  id: frame.id,
                  error: { message: `Unknown method: ${frame.method}`, code: "unknown_method" },
                }),
              );
            }
          }
        },
        drain: (socket: Socket<ClientSocketData>) => {
          this.writer.flush(socket);
        },
        close: (_socket, error) => {
          this.closed = true;
          this.pending.rejectAll(error ? "browser connection errored" : "browser closed");
          this.handlers.onClose?.(error ? "error" : "closed");
        },
      },
    });
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.closed;
  }

  request<T>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.socket) return Promise.reject(new PricklyError("not connected to the browser", "internal"));
    const id = nextId("a");
    const promise = this.pending.add(id, timeoutMs) as Promise<T>;
    this.writer.write(this.socket, encodeFrame({ kind: "request", id, method, params }));
    return promise;
  }

  async hello(client: string): Promise<unknown> {
    return this.request("hello", { protocolVersion: 1, client });
  }

  async listTools(): Promise<ToolSchema[]> {
    const result = await this.request<{ tools: ToolSchema[] }>("tools/list", {});
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ToolResult> {
    return this.request<ToolResult>(
      "tools/call",
      { name, arguments: args, ...(sessionId ? { session: { sessionId } } : {}) },
      timeoutMs,
    );
  }

  close(reason = "client closing"): void {
    this.closed = true;
    this.pending.rejectAll(reason);
    this.socket?.end();
    this.socket = null;
  }
}

// ---------------------------------------------------------------------------
// Socket server (native host side)
// ---------------------------------------------------------------------------

export interface SocketServerHandlers {
  onRequest(frame: Request, reply: (result: unknown, error?: PricklyError) => void): void;
  broadcast?(event: ProtocolEvent): void;
  /** An agent disconnected; these are the sessions it was driving. */
  onClientGone?(sessionIds: string[]): void;
}

export class BrowserSocketServer {
  private server: UnixSocketListener<ServerSocketData> | null = null;
  private clients = new Set<Socket<ServerSocketData>>();

  constructor(
    readonly path: string,
    private readonly handlers: SocketServerHandlers,
  ) {}

  async listen(): Promise<void> {
    rmSync(this.path, { force: true });
    this.server = await listen<ServerSocketData>({
      unix: this.path,
      // Seed data so the open handler is not racing the first data event;
      // socket.data is undefined until something assigns it.
      data: {},
      socket: {
        data: (socket: Socket<ServerSocketData>, chunk: Uint8Array) => {
          const frameDecoder = (socket.data.decoder ??= new FrameDecoder());

          let frames: Frame[];
          try {
            frames = frameDecoder.push(chunk);
          } catch (err) {
            console.error("[prickly-host] framing error from client", err);
            socket.end();
            return;
          }
          for (const frame of frames) {
            if (frame.kind !== "request") continue;
            // Remember which sessions this client drives; if it disconnects
            // without closing them, the host can tidy up on its behalf.
            const sid = (frame.params as { session?: { sessionId?: string } })?.session?.sessionId;
            if (sid) (socket.data.sessions ??= new Set()).add(sid);
            this.handlers.onRequest(frame, (result, error) => {
              const response: Response = error
                ? { kind: "response", id: frame.id, error: error.toProtocol() }
                : { kind: "response", id: frame.id, result };
              try {
                const writer = (socket.data.writer ??= new SocketWriter());
                writer.write(socket, encodeFrame(response));
              } catch {
                this.clients.delete(socket);
              }
            });
          }
        },
        open: (socket: Socket<ServerSocketData>) => {
          socket.data.decoder ??= new FrameDecoder();
          socket.data.writer ??= new SocketWriter();
          this.clients.add(socket);
        },
        drain: (socket: Socket<ServerSocketData>) => {
          socket.data.writer?.flush(socket);
        },
        close: (socket: Socket<ServerSocketData>) => {
          this.clients.delete(socket);
          const sessions = [...(socket.data.sessions ?? [])];
          if (sessions.length) this.handlers.onClientGone?.(sessions);
        },
      },
    });
  }

  /** Push an event to every connected agent. */
  broadcast(event: ProtocolEvent): void {
    const bytes = encodeFrame(event);
    for (const client of this.clients) {
      try {
        const writer = (client.data.writer ??= new SocketWriter());
        writer.write(client, bytes);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.clients.clear();
    rmSync(this.path, { force: true });
  }
}
