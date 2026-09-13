/**
 * chrome.debugger wrapper.
 *
 * Attaching is slow (Chrome wants a beat after attach before it will answer)
 * and it shows the user a yellow "being debugged" banner, so we keep sessions
 * warm: the last in-flight call for a tab starts a timer instead of detaching,
 * and any new call cancels it. Rapid tool sequences pay the attach cost once,
 * an idle agent lets the banner go away on its own.
 */

import { PricklyError } from "@shared/protocol";

const PROTOCOL = "1.3";

/** How long a session stays attached with nothing in flight. */
const IDLE_DETACH_MS = 20_000;

/** Chrome answers attach before it is really ready. */
const POST_ATTACH_SETTLE_MS = 400;

const ATTACH_ATTEMPTS = 4;
const ATTACH_RETRY_MS = 200;

export type CdpEventHandler = (params: unknown) => void;

/** Domains cost real overhead, so we enable each one at most once per attach. */
type Domain = "Page" | "Runtime" | "Network" | "Fetch" | "DOM" | "Log";

export class CdpSession {
  private attached = false;
  private inFlight = 0;
  private detachTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = new Set<Domain>();
  private handlers = new Map<string, Set<CdpEventHandler>>();

  constructor(readonly tabId: number) {}

  get isAttached(): boolean {
    return this.attached;
  }

  // -------------------------------------------------------------------------
  // Attach / detach
  // -------------------------------------------------------------------------

  async attach(): Promise<void> {
    this.cancelIdleDetach();
    if (this.attached) return;

    let lastError = "";
    for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
      try {
        await chrome.debugger.attach({ tabId: this.tabId }, PROTOCOL);
        this.attached = true;
        await sleep(POST_ATTACH_SETTLE_MS);
        return;
      } catch (err) {
        lastError = String((err as Error)?.message ?? err);

        // Someone else is already attached and it is us: treat as success.
        if (lastError.includes("Another debugger is already attached")) {
          const targets = await chrome.debugger.getTargets();
          const mine = targets.find((t) => t.tabId === this.tabId && t.attached);
          if (mine) {
            this.attached = true;
            return;
          }
          throw new PricklyError(
            "Another debugger is attached to this tab. Close DevTools for it and retry.",
            "attach_failed",
          );
        }

        // Foreign extension iframes genuinely break attach. Password managers
        // are the usual culprit. Strip them and try again.
        if (lastError.includes("chrome-extension://")) {
          await stripExtensionInterference(this.tabId);
        }
        await sleep(ATTACH_RETRY_MS);
      }
    }
    throw new PricklyError(
      `Could not attach the debugger to tab ${this.tabId}: ${lastError}`,
      "attach_failed",
    );
  }

  async detach(): Promise<void> {
    this.cancelIdleDetach();
    if (!this.attached) return;
    this.attached = false;
    this.enabled.clear();
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // Tab closed underneath us. Nothing to clean up.
    }
  }

  /** Called by the debugger's own detach event, not by us. */
  markDetached(): void {
    this.attached = false;
    this.enabled.clear();
    this.cancelIdleDetach();
  }

  private cancelIdleDetach(): void {
    if (this.detachTimer !== null) {
      clearTimeout(this.detachTimer);
      this.detachTimer = null;
    }
  }

  private scheduleIdleDetach(): void {
    this.cancelIdleDetach();
    // Network capture and interception need the session to stay up between
    // calls, so a domain being enabled pins the session open.
    if (this.enabled.has("Network") || this.enabled.has("Fetch")) return;
    this.detachTimer = setTimeout(() => {
      if (this.inFlight === 0) void this.detach();
    }, IDLE_DETACH_MS);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.attach();
    this.inFlight++;
    try {
      return (await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        method,
        params,
      )) as T;
    } catch (err) {
      throw new PricklyError(
        `CDP ${method} failed: ${String((err as Error)?.message ?? err)}`,
        "internal",
      );
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.scheduleIdleDetach();
    }
  }

  async enable(domain: Domain, params: Record<string, unknown> = {}): Promise<void> {
    if (this.enabled.has(domain)) return;
    await this.send(`${domain}.enable`, params);
    this.enabled.add(domain);
    this.cancelIdleDetach();
  }

  async disable(domain: Domain): Promise<void> {
    if (!this.enabled.has(domain)) return;
    this.enabled.delete(domain);
    try {
      await this.send(`${domain}.disable`);
    } catch {
      // Detached already.
    }
  }

  isEnabled(domain: Domain): boolean {
    return this.enabled.has(domain);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  dispatch(method: string, params: unknown): void {
    const set = this.handlers.get(method);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(params);
      } catch (err) {
        console.error(`[prickly] handler for ${method} threw`, err);
      }
    }
  }

  /** Resolves on the next occurrence of an event, or rejects on timeout. */
  once(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new PricklyError(`timed out waiting for ${method}`, "timeout"));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const sessions = new Map<number, CdpSession>();

export function cdp(tabId: number): CdpSession {
  let session = sessions.get(tabId);
  if (!session) {
    session = new CdpSession(tabId);
    sessions.set(tabId, session);
  }
  return session;
}

export function existingCdp(tabId: number): CdpSession | undefined {
  return sessions.get(tabId);
}

export async function detachAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => s.detach()));
  sessions.clear();
}

/**
 * Extra fan-out, registered by the service worker so this module does not
 * depend on the network layer (which depends on this one).
 */
type GlobalEventHandler = (tabId: number, method: string, params: unknown) => void;
const globalHandlers: GlobalEventHandler[] = [];

export function onAnyCdpEvent(handler: GlobalEventHandler): void {
  globalHandlers.push(handler);
}

export function onTabClosed(handler: (tabId: number) => void): void {
  tabClosedHandlers.push(handler);
}

const tabClosedHandlers: ((tabId: number) => void)[] = [];

/**
 * Wire up the global debugger events once. chrome.debugger hands every event
 * for every tab to a single listener, so this fans them back out.
 */
export function installCdpListeners(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    const session = sessions.get(source.tabId);

    // Dialogs are answered here rather than in a tool, because they can open
    // at any point and an unanswered dialog wedges the whole tab.
    if (method === "Page.javascriptDialogOpening" && session) {
      void handleDialog(session, params as DialogOpening);
    }
    session?.dispatch(method, params);

    // Network and Fetch events arrive whether or not a session object exists
    // yet, and the capture buffer outlives individual tool calls.
    for (const handler of globalHandlers) {
      try {
        handler(source.tabId, method, params);
      } catch (err) {
        console.error(`[prickly] global CDP handler threw`, err);
      }
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    sessions.get(source.tabId)?.markDetached();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = sessions.get(tabId);
    if (session) {
      session.markDetached();
      sessions.delete(tabId);
    }
    for (const handler of tabClosedHandlers) handler(tabId);
  });
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

interface DialogOpening {
  url: string;
  message: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  defaultPrompt?: string;
}

export interface DialogRecord extends DialogOpening {
  at: number;
  accepted: boolean;
}

/** Last few dialogs per tab, so a tool can report what it dismissed. */
const dialogLog = new Map<number, DialogRecord[]>();

/**
 * Policy per tab. `beforeunload` defaults to accept so navigation is not
 * blocked by an unsaved-changes prompt the agent cannot see.
 */
export interface DialogPolicy {
  accept: boolean;
  promptText?: string;
}

const dialogPolicies = new Map<number, DialogPolicy>();

export function setDialogPolicy(tabId: number, policy: DialogPolicy): void {
  dialogPolicies.set(tabId, policy);
}

export function takeDialogs(tabId: number): DialogRecord[] {
  const log = dialogLog.get(tabId) ?? [];
  dialogLog.delete(tabId);
  return log;
}

async function handleDialog(session: CdpSession, dialog: DialogOpening): Promise<void> {
  const policy = dialogPolicies.get(session.tabId) ?? { accept: true };
  const accept = dialog.type === "beforeunload" ? true : policy.accept;

  const log = dialogLog.get(session.tabId) ?? [];
  log.push({ ...dialog, at: Date.now(), accepted: accept });
  dialogLog.set(session.tabId, log.slice(-10));

  try {
    await chrome.debugger.sendCommand(
      { tabId: session.tabId },
      "Page.handleJavaScriptDialog",
      accept && policy.promptText !== undefined
        ? { accept, promptText: policy.promptText }
        : { accept },
    );
  } catch (err) {
    console.error("[prickly] failed to answer dialog", err);
  }
}

// ---------------------------------------------------------------------------
// Interference
// ---------------------------------------------------------------------------

/**
 * Other extensions inject iframes, and CDP refuses to attach when it finds a
 * cross-extension frame. Walk every frame, including closed shadow roots, and
 * remove the foreign ones.
 */
async function stripExtensionInterference(tabId: number): Promise<void> {
  const { stripInterference } = await chrome.storage.local.get("stripInterference");
  if (stripInterference === false) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        const ownOrigin = location.origin;
        const walk = (root: ParentNode): void => {
          for (const frame of root.querySelectorAll("iframe")) {
            const src = frame.getAttribute("src") ?? "";
            if (src.startsWith("chrome-extension://") && !src.startsWith(ownOrigin)) {
              frame.remove();
            }
          }
          for (const el of root.querySelectorAll("*")) {
            // Only open shadow roots are reachable from MAIN world. Closed
            // roots would need chrome.dom.openOrClosedShadowRoot, which is
            // extension-world only; a foreign iframe inside one is rare enough
            // to leave alone.
            const shadow = el.shadowRoot ?? null;
            if (shadow) walk(shadow);
          }
        };
        walk(document);
      },
    });
  } catch {
    // Restricted page. Attach was going to fail for a different reason.
  }
  await sleep(75);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
