/**
 * Service worker entry point.
 *
 * Owns exactly three jobs: keep the native connection up, route methods to the
 * tool registry, and keep the service worker itself alive long enough for a
 * long-running tool call to finish.
 *
 * MV3 kills a service worker after 30s idle. A native messaging port does
 * reset that timer, but Chrome has changed its mind about that more than once,
 * so there is also an alarm tick and an offscreen document heartbeat. Cheap
 * insurance against a browser automation session dying mid-click.
 */

import { PROTOCOL_VERSION, type BrowserIdentity } from "@shared/protocol";
import { NATIVE_HOST_NAME, initNativeTransport } from "./transport/native";
import {
  installCdpListeners,
  onAnyCdpEvent,
  onTabClosed,
} from "./core/cdp";
import { identity } from "./core/identity";
import { executeTool, listTools } from "./core/registry";
import { handleNetworkEvent, handleRequestPaused, forget as forgetNetwork } from "./core/network";
import { forgetGeometry } from "./core/screenshot";
import { forgetWorld } from "./core/page";

// Registering a tool has the side effect of putting it in the registry.
import "./tools/tabs";
import "./tools/navigate";
import "./tools/computer";
import "./tools/reading";
import "./tools/network";
import "./tools/script";
import "./tools/batch";

const KEEPALIVE_ALARM = "prickly-keepalive";
const OFFSCREEN_PATH = "offscreen.html";

let connected = false;
const identityPromise: Promise<BrowserIdentity> = identity();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

installCdpListeners();

onAnyCdpEvent((tabId, method, params) => {
  if (method === "Fetch.requestPaused") {
    void handleRequestPaused(tabId, params);
    return;
  }
  if (method.startsWith("Network.")) {
    void handleNetworkEvent(tabId, method, params);
  }
});

onTabClosed((tabId) => {
  forgetGeometry(tabId);
  forgetNetwork(tabId);
  forgetWorld(tabId);
});

const connection = initNativeTransport(identityPromise, (isConnected) => {
  connected = isConnected;
  void updateBadge(isConnected);
});

connection.on("hello", async (params) => {
  const request = params as { protocolVersion?: number; client?: string };
  const me = await identityPromise;
  if (request?.protocolVersion && request.protocolVersion !== PROTOCOL_VERSION) {
    // Still answer; the host decides whether a mismatch is fatal.
    console.warn(
      `[prickly] host speaks protocol ${request.protocolVersion}, extension speaks ${PROTOCOL_VERSION}`,
    );
  }
  return me;
});

connection.on("ping", async () => ({ pong: true }));

connection.on("tools/list", async () => ({ tools: listTools() }));

connection.on("tools/call", async (params) => {
  const call = params as {
    name?: string;
    arguments?: Record<string, unknown>;
    session?: { sessionId?: string; tabGroupId?: number };
  };
  if (!call?.name) {
    return {
      content: [{ type: "text", text: "tools/call needs a tool name." }],
      isError: true,
    };
  }
  return executeTool({
    name: call.name,
    args: call.arguments ?? {},
    session: call.session?.sessionId ? { sessionId: call.session.sessionId } : undefined,
    client: connection.status().client,
  });
});

/**
 * Reload the extension from the wire.
 *
 * Unpacked extensions re-read their files on reload, so this picks up a fresh
 * `bun run build` without touching the browser UI. chrome.runtime.reload()
 * tears down this service worker, which drops the native port and kills the
 * host, so the reply has to go out first and the reload has to happen on a
 * later tick. The extension then reconnects on its own and the browser spawns
 * a new host.
 */
connection.on("reload", async () => {
  setTimeout(() => chrome.runtime.reload(), 150);
  return { reloading: true, note: "reconnects within a few seconds" };
});

connection.on("get_status", async () => {
  const me = await identityPromise;
  return { ...connection.status(), identity: me, tools: listTools().length };
});

/**
 * Diagnostics: what windows and tabs this extension instance can actually see.
 * Useful for understanding how a browser scopes an extension across profiles.
 */
connection.on("diagnostics", async () => {
  const windows = await chrome.windows.getAll({ populate: true }).catch(() => []);
  const allTabs = await chrome.tabs.query({}).catch(() => []);
  return {
    windowCount: windows.length,
    windows: windows.map((w) => ({
      id: w.id,
      focused: w.focused,
      type: w.type,
      tabCount: w.tabs?.length ?? 0,
    })),
    tabCount: allTabs.length,
    tabs: allTabs.slice(0, 30).map((t) => ({
      id: t.id,
      windowId: t.windowId,
      groupId: t.groupId,
      active: t.active,
      url: t.url?.slice(0, 60),
      title: t.title?.slice(0, 40),
    })),
  };
});

// ---------------------------------------------------------------------------
// Keepalive
// ---------------------------------------------------------------------------

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!connected) void connection.connect(identityPromise);
  void ensureOffscreen();
});

/**
 * Offscreen documents are exempt from the idle kill, so one pinging the
 * service worker every 20s holds it open across a long tool call.
 */
async function ensureOffscreen(): Promise<void> {
  if (!chrome.offscreen?.createDocument) return;
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: [chrome.runtime.ContextType?.OFFSCREEN_DOCUMENT].filter(Boolean) as never,
  }).catch(() => []);
  if (existing?.length) return;
  await chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Keeps the service worker alive during long browser automation calls",
    })
    .catch(() => {
      // Already there, or unsupported. Either way, not fatal.
    });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SW_KEEPALIVE") return;
  if (message?.type === "PRICKLY_STATUS") {
    return Promise.resolve(connection.status());
  }
  return undefined;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

async function bootstrap(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  await ensureOffscreen();
  await connection.connect(identityPromise);
}

async function updateBadge(isConnected: boolean): Promise<void> {
  await chrome.action
    .setBadgeText({ text: isConnected ? "" : "!" })
    .catch(() => {});
  await chrome.action
    .setBadgeBackgroundColor({ color: "#c0392b" })
    .catch(() => {});
  await chrome.action
    .setTitle({
      title: isConnected
        ? `Prickly — connected to ${NATIVE_HOST_NAME}`
        : "Prickly — native host not connected (run scripts/install-host.ts)",
    })
    .catch(() => {});
}

void bootstrap();
