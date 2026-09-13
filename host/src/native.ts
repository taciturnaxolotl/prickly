/**
 * The native messaging host Chrome spawns.
 *
 * Chrome runs one of these per browser profile. It speaks the length-prefixed
 * protocol on stdin/stdout to the extension, and serves the same protocol on a
 * unix socket to any number of agent processes. The socket path goes in the
 * registry so agents can find it without being told.
 *
 * The extension announces itself with a `register` request carrying its
 * identity; until that lands we do not know which profile we are, so the
 * socket is not opened yet.
 */

import { ExtensionPeer, BrowserSocketServer } from "./client";
import {
  ensureRegistryDir,
  removeDescriptor,
  socketPath,
  writeDescriptor,
  type BrowserDescriptor,
} from "./registry";
import { PricklyError, type BrowserIdentity, type Request } from "../../shared/protocol";
import { HOST_VERSION } from "./version";

const STDIN = Bun.file(0).stream();
const STDOUT = Bun.file(1).writer();

let browserId: string | null = null;
let server: BrowserSocketServer | null = null;

/**
 * Frames to the browser go out in order, one flush at a time.
 *
 * FileSink.write() buffers and flush() is async, so firing flushes
 * concurrently can interleave two frames on stdout and desync the
 * length-prefixed stream. Chaining them keeps writes ordered without blocking
 * the caller.
 */
let flushChain: Promise<unknown> = Promise.resolve();

function write(bytes: Uint8Array): void {
  STDOUT.write(bytes);
  flushChain = flushChain.then(() => STDOUT.flush()).catch((err) => {
    log(`stdout flush failed: ${String(err)}`);
  });
}

const peer = new ExtensionPeer({
  input: STDIN,
  write,
  onClose: (reason) => {
    log(`extension disconnected: ${reason}`);
    shutdown(0);
  },
});

function log(message: string): void {
  // stderr, because stdout is the protocol.
  console.error(`[prickly-host:${process.pid}] ${message}`);
}

// ---------------------------------------------------------------------------
// Extension -> host
// ---------------------------------------------------------------------------

peer.handle("register", async (params) => {
  const { identity } = params as { identity: BrowserIdentity };
  const id = identity?.browserId;
  if (!id) throw new PricklyError("register needs an identity.browserId", "bad_params");

  browserId = id;
  ensureRegistryDir();
  const sock = socketPath(id);

  server = new BrowserSocketServer(sock, {
    onRequest: (frame: Request, reply) => {
      void forwardToExtension(frame, reply);
    },
  });
  await server.listen();

  const descriptor: BrowserDescriptor = {
    browserId: identity.browserId,
    profile: identity.profile,
    browser: identity.browser,
    browserVersion: identity.browserVersion,
    platform: identity.platform,
    extensionId: identity.extensionId,
    protocolVersion: identity.protocolVersion,
    socket: sock,
    pid: process.pid,
    startedAt: Date.now(),
    hostVersion: HOST_VERSION,
  };
  writeDescriptor(descriptor);
  log(`serving ${identity.profile} (${identity.browser}) on ${sock}`);

  // The reply to register is the whole handshake: it carries the socket back
  // to the extension's connect() promise. No separate hello round-trip, which
  // would otherwise leave an unmatched response id on the extension's reply.
  return { ok: true, socket: sock, hostVersion: HOST_VERSION, client: "prickly-host" };
});

peer.events((event) => {
  // Anything the extension volunteers gets fanned out to connected agents.
  server?.broadcast(event);
  if (event.event === "goodbye") {
    log(`extension said goodbye: ${JSON.stringify(event.params)}`);
    shutdown(0);
  }
});

peer.handle("ping", async () => ({ pong: true }));

/**
 * Client requests are forwarded verbatim, including their ids, so correlation
 * survives the hop. That is what makes several agents share one browser
 * without the host having to understand any tool.
 */
async function forwardToExtension(
  frame: Request,
  reply: (result: unknown, error?: PricklyError) => void,
): Promise<void> {
  if (!browserId) {
    reply(undefined, new PricklyError("browser has not registered yet", "internal"));
    return;
  }
  try {
    const result = await peer.request(frame.method, frame.params, frameTimeout(frame));
    reply(result);
  } catch (err) {
    reply(
      undefined,
      err instanceof PricklyError
        ? err
        : new PricklyError(String((err as Error)?.message ?? err), "internal"),
    );
  }
}

/** Long-running tools get longer leashes than a ping does. */
function frameTimeout(frame: Request): number {
  if (frame.method !== "tools/call") return 15_000;
  const name = (frame.params as { name?: string })?.name;
  if (name === "computer" || name === "browser_batch" || name === "navigate") return 180_000;
  if (name === "javascript_eval") return 90_000;
  return 60_000;
}

// Ids are scoped per hop. A client's id only identifies the request on its own
// socket, and the reply closure carries it back there; the host-to-extension
// hop uses ids from its own counter. Nothing is shared, so nothing collides
// when two agents talk to one browser at once.

// ---------------------------------------------------------------------------
// Stdin pump
// ---------------------------------------------------------------------------

async function pump(): Promise<void> {
  const reader = STDIN.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) peer.feed(value);
  }
  log("stdin closed");
  shutdown(0);
}

function shutdown(code: number): void {
  if (browserId) removeDescriptor(browserId);
  server?.stop();
  peer.close("host shutting down");
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(0));
}
process.on("exit", () => {
  if (browserId) removeDescriptor(browserId);
});
process.on("uncaughtException", (err) => {
  log(`uncaught: ${String(err)}`);
});

log(`started, waiting for the extension to register`);
void pump();
