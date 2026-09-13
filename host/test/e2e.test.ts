/**
 * End-to-end test of the host chain with no browser involved.
 *
 * Stands in for the extension on Chrome's stdin/stdout, then drives the host
 * over the unix socket the way an agent would. Covers the parts most likely to
 * be subtly wrong: length-prefixed framing across an async boundary, the
 * registry descriptor, id correlation, and two clients sharing one browser at
 * once (which the upstream design cannot do).
 *
 * Run: bun test host/test/e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../../shared/framing";
import { nextId, type Frame, type ToolResult } from "../../shared/protocol";
import { socketPath } from "../src/registry";
import { BrowserClient } from "../src/client";

const FAKE_BROWSER_ID = "test-browser-e2e";
const HOST = join(import.meta.dir, "..", "bin", "prickly.ts");

/** The socket registry is shared, so isolate this run's directory. Set it in
 * this process too, or socketPath() here would point somewhere else. */
const SOCKET_DIR = join(import.meta.dir, ".sockets");
process.env.PRICKLY_SOCKET_DIR = SOCKET_DIR;

let host: Bun.Subprocess<"pipe", "pipe", "inherit">;
let decoder = new FrameDecoder();
/** Requests the host sent us, keyed by id, answered by the fake tool below. */
const fromHost: ((frame: Extract<Frame, { kind: "request" }>) => void)[] = [];

function fakeTool(name: string, args: Record<string, unknown>): ToolResult {
  if (name === "echo") {
    return { content: [{ type: "text", text: JSON.stringify(args) }] };
  }
  if (name === "whoami") {
    return { content: [{ type: "text", text: "fake extension" }] };
  }
  return { content: [{ type: "text", text: `ran ${name}` }] };
}

function sendToHost(frame: Frame): void {
  host.stdin.write(encodeFrame(frame));
  host.stdin.flush();
}

function answerHost(id: string, result: unknown): void {
  sendToHost({ kind: "response", id, result });
}

async function waitForHostRequest(timeoutMs = 4000): Promise<Extract<Frame, { kind: "request" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a host request")), timeoutMs);
    fromHost.push((frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

beforeAll(async () => {
  rmSync(SOCKET_DIR, { recursive: true, force: true });
  host = Bun.spawn([process.execPath, "run", HOST, "native-host"], {
    env: { ...process.env, PRICKLY_SOCKET_DIR: SOCKET_DIR },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  // Pump the host's stdout (its native-messaging channel to us). Bun exposes
  // it as a web ReadableStream, so read it with an async loop rather than
  // node's .on("data").
  //
  // hello is answered inline: every client sends one on connect, and they are
  // pure handshakes. Surfacing them to waiters would desync the tool-call
  // assertions below. Everything else (tools/list, tools/call) goes to the
  // next waiter.
  void (async () => {
    const reader = host.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of decoder.push(value)) {
        if (frame.kind !== "request") continue;
        if (frame.method === "hello") {
          sendToHost({ kind: "response", id: frame.id, result: { pong: true } });
          continue;
        }
        const waiter = fromHost.shift();
        if (waiter) {
          waiter(frame);
        } else if (process.env.PRICKLY_E2E_DEBUG) {
          console.error(`[test] no waiter for ${frame.method} id=${frame.id}`);
        }
      }
    }
  })();

  // Register, exactly as the real extension does on connect. The host answers
  // register with the socket path; we just wait for the socket file to appear,
  // which is the signal that the server is listening and the descriptor is
  // written.
  const registerId = nextId("reg");
  sendToHost({
    kind: "request",
    id: registerId,
    method: "register",
    params: {
      identity: {
        browserId: FAKE_BROWSER_ID,
        browser: "Chrome",
        browserVersion: "999.0",
        profile: "fake",
        extensionId: "fokpacegneepaffhbphkadjgljingnbp",
        platform: "macos",
        protocolVersion: 1,
      },
    },
  });

  const sock = socketPath(FAKE_BROWSER_ID);
  // Give the host a moment to register and open its socket. Bun.sleep yields
  // to the event loop without depending on a timer that the stdout pump might
  // otherwise starve.
  for (let i = 0; i < 100 && !existsSync(sock); i++) {
    await Bun.sleep(20);
  }
  expect(existsSync(sock)).toBe(true);
});

afterAll(() => {
  host.stdin.end();
  host.kill();
  rmSync(SOCKET_DIR, { recursive: true, force: true });
});

describe("host chain", () => {
  test("register produces a live socket and descriptor", async () => {
    const { listBrowsers } = await import("../src/registry");
    process.env.PRICKLY_SOCKET_DIR = SOCKET_DIR;
    const browsers = listBrowsers();
    const mine = browsers.find((b) => b.browserId === FAKE_BROWSER_ID);
    expect(mine).toBeDefined();
    expect(mine!.profile).toBe("fake");
    expect(mine!.socket).toBe(socketPath(FAKE_BROWSER_ID));
  });

  test("a client can list tools through the host", async () => {
    const client = new BrowserClient(socketPath(FAKE_BROWSER_ID));
    await client.connect();
    await client.hello("test-agent");

    const listPromise = client.listTools();
    const request = await waitForHostRequest();
    expect(request.method).toBe("tools/list");
    answerHost(request.id, {
      tools: [
        { name: "whoami", description: "who", inputSchema: { type: "object", properties: {} } },
        { name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } },
      ],
    });

    const tools = await listPromise;
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "whoami"]);
    client.close();
  });

  test("a tool call round-trips with its arguments", async () => {
    const client = new BrowserClient(socketPath(FAKE_BROWSER_ID));
    await client.connect();

    const callPromise = client.callTool("echo", { hello: "world", n: 3 }, "session-1");
    const request = await waitForHostRequest();
    expect(request.method).toBe("tools/call");
    const params = request.params as { name: string; arguments: Record<string, unknown>; session?: { sessionId: string } };
    expect(params.name).toBe("echo");
    expect(params.arguments).toEqual({ hello: "world", n: 3 });
    expect(params.session?.sessionId).toBe("session-1");

    answerHost(request.id, fakeTool(params.name, params.arguments));
    const result = await callPromise;
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify({ hello: "world", n: 3 }) });
    client.close();
  });

  /**
   * Regression: Bun's socket.write() takes only what the kernel buffer holds
   * and returns that count. Ignoring it truncates any frame past the buffer
   * size, which desyncs the length-prefixed stream for good. Small frames
   * always fit, so nothing below ~16 KB would have caught it. A megabyte in
   * each direction is well clear of the threshold.
   */
  test("frames larger than the socket buffer survive both directions", async () => {
    const client = new BrowserClient(socketPath(FAKE_BROWSER_ID));
    await client.connect();
    await client.hello("agent-big");

    const bigArg = "a".repeat(1024 * 1024);
    const bigReply = "b".repeat(1024 * 1024);

    const requestP = waitForHostRequest(15_000);
    const callP = client.callTool("echo", { blob: bigArg }, "session-big", 20_000);

    const request = await requestP;
    const params = request.params as { arguments: { blob: string } };
    // Survived agent -> host -> extension intact.
    expect(params.arguments.blob.length).toBe(bigArg.length);
    expect(params.arguments.blob).toBe(bigArg);

    answerHost(request.id, { content: [{ type: "text", text: bigReply }] });

    const result = await callP;
    const block = result.content[0] as { type: "text"; text: string };
    // And extension -> host -> agent intact.
    expect(block.text.length).toBe(bigReply.length);
    expect(block.text).toBe(bigReply);
    client.close();
  });

  test("two clients interleave against one browser, ids do not collide", async () => {
    const a = new BrowserClient(socketPath(FAKE_BROWSER_ID));
    const b = new BrowserClient(socketPath(FAKE_BROWSER_ID));
    await a.connect();
    await b.connect();
    await a.hello("agent-a");
    await b.hello("agent-b");

    // Register both waiters before firing the calls. The host forwards a
    // client request to the extension synchronously, so a waiter attached
    // after callTool() can miss the forwarded frame entirely.
    const firstP = waitForHostRequest();
    const secondP = waitForHostRequest();

    // Fire both before answering either, so they are genuinely in flight at once.
    const callA = a.callTool("whoami", {}, "session-a");
    const callB = b.callTool("whoami", {}, "session-b");

    const first = await firstP;
    const second = await secondP;
    expect(first.id).not.toBe(second.id);

    // Answer out of order to prove correlation is by id, not by arrival.
    answerHost(second.id, { content: [{ type: "text", text: "second" }] });
    answerHost(first.id, { content: [{ type: "text", text: "first" }] });

    const [resA, resB] = await Promise.all([callA, callB]);
    const order = new Set([
      (resA.content[0] as { text: string }).text,
      (resB.content[0] as { text: string }).text,
    ]);
    expect(order.size).toBe(2);
    a.close();
    b.close();
  });

  test("an extension error surfaces as a rejected call, not a hang", async () => {
    const client = new BrowserClient(socketPath(FAKE_BROWSER_ID));
    await client.connect();
    await client.hello("agent-err");

    const request = waitForHostRequest();
    const call = client.callTool("boom", {}, "session-x");
    const req = await request;
    sendToHost({
      kind: "response",
      id: req.id,
      error: { message: "the page navigated away", code: "navigated_away" },
    });

    await expect(call).rejects.toThrow("the page navigated away");
    client.close();
  });
});
