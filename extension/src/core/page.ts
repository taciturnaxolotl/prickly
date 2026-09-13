/**
 * Service-worker side of the page agent.
 *
 * chrome.scripting.executeScript in the default isolated world shares globals
 * with our own content scripts, so these calls reach the same ref map the
 * content script built. If the content script has not run yet (a tab that was
 * open before the extension loaded), inject it on demand.
 */

import { PricklyError } from "@shared/protocol";

const PAGE_AGENT_FILE = "page-agent.js";

async function ensureInjected(tabId: number, frameId = 0): Promise<void> {
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: () => typeof (window as { __prickly?: unknown }).__prickly !== "undefined",
  });
  if (probe?.result === true) return;

  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: [PAGE_AGENT_FILE],
  });
}

/**
 * Calls a method on the page agent. Typed loosely on purpose: the return value
 * crosses a structured-clone boundary, so it is plain JSON by the time we see
 * it.
 */
async function invoke<T>(
  tabId: number,
  method: string,
  args: unknown[],
  frameId = 0,
): Promise<T> {
  await ensureInjected(tabId, frameId);
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    args: [method, args],
    func: (m: string, a: unknown[]) => {
      const agent = (window as unknown as Record<string, Record<string, unknown>>).__prickly;
      if (!agent) return { __pricklyError: "page agent is not loaded in this frame" };
      const fn = agent[m];
      if (typeof fn !== "function") return { __pricklyError: `no page agent method ${m}` };
      try {
        return (fn as (...rest: unknown[]) => unknown)(...a);
      } catch (err) {
        return { __pricklyError: String((err as Error)?.message ?? err) };
      }
    },
  });

  const result = frame?.result as T | { __pricklyError: string } | undefined;
  if (result === undefined) {
    throw new PricklyError(
      "The page did not respond. It may be a restricted URL or still loading.",
      "internal",
    );
  }
  if (typeof result === "object" && result !== null && "__pricklyError" in result) {
    throw new PricklyError((result as { __pricklyError: string }).__pricklyError);
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Typed surface
// ---------------------------------------------------------------------------

export interface TreeOptions {
  maxDepth?: number;
  filter?: "all" | "interactive";
  rootRef?: string;
  maxChars?: number;
}

export interface TreeResult {
  text: string;
  truncated: boolean;
  fullLength: number;
  nodeCount: number;
  url: string;
  title: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface SearchMatch {
  ref: string;
  role: string;
  name: string;
  score: number;
  detail: string;
}

export function readTree(tabId: number, options: TreeOptions): Promise<TreeResult> {
  return invoke<TreeResult>(tabId, "tree", [options]);
}

export function readText(tabId: number): Promise<string> {
  return invoke<string>(tabId, "text", []);
}

export function searchPage(
  tabId: number,
  query: string,
  limit: number,
): Promise<{ matches: SearchMatch[]; scanned: number }> {
  return invoke(tabId, "search", [query, limit]);
}

/**
 * Viewport-space centre of a ref, scrolled into view. Every ref-taking tool
 * funnels through this, which is why a stale ref fails loudly rather than
 * clicking the wrong thing.
 */
export async function refRect(tabId: number, ref: string): Promise<Rect> {
  const result = await invoke<
    { ok: true } & Rect | { ok: false; error: string }
  >(tabId, "rect", [ref]);
  if (!result.ok) throw new PricklyError(result.error, "internal");
  return result;
}

export async function setRefValue(
  tabId: number,
  ref: string,
  value: string,
): Promise<void> {
  const result = await invoke<{ ok: boolean; error?: string }>(tabId, "setValue", [
    ref,
    value,
  ]);
  if (!result.ok) throw new PricklyError(result.error ?? "could not set value");
}

export async function describeRef(
  tabId: number,
  ref: string,
): Promise<{ ref: string; role: string; name: string }> {
  const result = await invoke<
    { ok: true; ref: string; role: string; name: string } | { ok: false; error: string }
  >(tabId, "resolve", [ref]);
  if (!result.ok) throw new PricklyError(result.error, "internal");
  return result;
}
