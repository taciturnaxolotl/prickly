/**
 * An agent that starts before any browser answers must still learn about the
 * browser's tools later. Starts the MCP server against an empty registry,
 * then brings a fake browser up and down underneath it, and checks that the
 * server tells the client to fetch the tool list again each time.
 *
 * Run: bun test host/test/list-changed.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../../shared/framing";
import { nextId, type Frame } from "../../shared/protocol";
import { socketPath } from "../src/registry";
import { McpServer } from "../src/mcp";

const SOCKET_DIR = join(import.meta.dir, ".sockets-list-changed");
process.env.PRICKLY_SOCKET_DIR = SOCKET_DIR;

const HOST = join(import.meta.dir, "..", "bin", "prickly.ts");
const BROWSER_ID = "test-browser-list-changed";

const messages: Record<string, unknown>[] = [];
const server = new McpServer((line) => {
  messages.push(JSON.parse(line) as Record<string, unknown>);
});

let host: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null;

function sendToHost(frame: Frame): void {
  host!.stdin.write(encodeFrame(frame));
  host!.stdin.flush();
}

async function startFakeBrowser(): Promise<void> {
  host = Bun.spawn([process.execPath, "run", HOST, "native-host"], {
    env: { ...process.env, PRICKLY_SOCKET_DIR: SOCKET_DIR },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const decoder = new FrameDecoder();
  void (async () => {
    const reader = host!.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of decoder.push(value)) {
        if (frame.kind !== "request") continue;
        const result =
          frame.method === "tools/list"
            ? { tools: [{ name: "navigate", description: "go", inputSchema: { type: "object", properties: {} } }] }
            : { pong: true };
        sendToHost({ kind: "response", id: frame.id, result });
      }
    }
  })();
  sendToHost({
    kind: "request",
    id: nextId("reg"),
    method: "register",
    params: {
      identity: {
        browserId: BROWSER_ID,
        browser: "Chrome",
        browserVersion: "999.0",
        profile: "fake",
        extensionId: "fokpacegneepaffhbphkadjgljingnbp",
        platform: "macos",
        protocolVersion: 1,
      },
    },
  });
  for (let i = 0; i < 100 && !existsSync(socketPath(BROWSER_ID)); i++) await Bun.sleep(20);
  expect(existsSync(socketPath(BROWSER_ID))).toBe(true);
}

let nextRequestId = 1;
async function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextRequestId++;
  server.feed(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  for (let i = 0; i < 300; i++) {
    const reply = messages.find((m) => m.id === id);
    if (reply) return reply;
    await Bun.sleep(10);
  }
  throw new Error(`no reply to ${method}`);
}

async function toolNames(): Promise<string[]> {
  const reply = await request("tools/list");
  return ((reply.result as { tools: { name: string }[] }).tools).map((t) => t.name).sort();
}

function listChangedCount(): number {
  return messages.filter((m) => m.method === "notifications/tools/list_changed").length;
}

async function waitForListChanged(count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (listChangedCount() < count && Date.now() < deadline) await Bun.sleep(20);
  expect(listChangedCount()).toBe(count);
}

beforeAll(() => {
  rmSync(SOCKET_DIR, { recursive: true, force: true });
});

afterAll(() => {
  server.close();
  host?.kill();
  rmSync(SOCKET_DIR, { recursive: true, force: true });
});

test("the tool list follows browsers that arrive and leave after startup", async () => {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  expect((init.result as { capabilities: { tools: { listChanged: boolean } } }).capabilities.tools.listChanged).toBe(
    true,
  );
  server.feed(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  expect(await toolNames()).toEqual(["prickly_browsers", "prickly_use_browser"]);

  await startFakeBrowser();
  await waitForListChanged(1);
  expect(await toolNames()).toEqual(["prickly_browsers", "prickly_navigate", "prickly_use_browser"]);

  // Asking again with nothing new must not set off another announcement.
  await Bun.sleep(800);
  expect(listChangedCount()).toBe(1);

  host!.kill();
  await host!.exited;
  host = null;
  await waitForListChanged(2);
  expect(await toolNames()).toEqual(["prickly_browsers", "prickly_use_browser"]);
});
