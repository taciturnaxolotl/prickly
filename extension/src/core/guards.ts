/**
 * Guards.
 *
 * Not a permission system. There is no server call, no grant store, no prompt.
 * What is here exists to stop a model from making a mistake it cannot see:
 * driving a page that navigated out from under it, typing into a page that is
 * still loading, reading its own credentials back into context, or wandering
 * onto a domain the user listed as off limits.
 */

import { PricklyError } from "@shared/protocol";

// ---------------------------------------------------------------------------
// URLs the browser will not let us drive
// ---------------------------------------------------------------------------

/**
 * Schemes the browser itself will not let an extension drive.
 *
 * file:// is deliberately absent. An agent can read local files through the
 * browser, which is a real capability, but it is one the agent almost always
 * already has through its own shell, and it is genuinely useful for looking at
 * saved pages and captured artefacts. Allowed on purpose, not by oversight.
 */
const RESTRICTED_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "devtools:",
  "edge:",
  "brave:",
  "about:",
];

/** about:blank is fine, it is a real page. The rest of about: is not. */
export function restrictedReason(url: string | undefined): string | null {
  if (!url) return null;
  if (url === "about:blank" || url === "about:srcdoc") return null;

  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return null;
  }
  if (RESTRICTED_SCHEMES.includes(scheme)) {
    return (
      `${scheme}// pages cannot be driven: the browser blocks both the debugger and ` +
      `script injection on them. Use an http(s) URL instead.`
    );
  }
  // Schemes the extension navigation API rejects outright. Caught here so the
  // caller gets a remedy it can actually use, rather than Chrome's raw advice
  // to call an extension API the caller has no access to.
  if (scheme === "javascript:") {
    return (
      "javascript: URLs cannot be navigated to. Use javascript_eval to run code " +
      "on the current page instead."
    );
  }
  if (scheme === "data:" || scheme === "blob:") {
    return (
      `${scheme} URLs cannot be navigated to by an extension. Open an http(s) URL, ` +
      `or build the content on a real page with javascript_eval.`
    );
  }
  return null;
}

export function assertDrivable(url: string | undefined): void {
  const reason = restrictedReason(url);
  if (reason) throw new PricklyError(reason, "restricted_url");
}

// ---------------------------------------------------------------------------
// Local denylist
// ---------------------------------------------------------------------------

export interface DenyRule {
  /** Host glob: "example.com", "*.example.com", "*" */
  host: string;
  /** Optional path prefix. */
  path?: string;
  note?: string;
}

const DENY_KEY = "denylist";
let denyCache: DenyRule[] | null = null;

export async function getDenylist(): Promise<DenyRule[]> {
  if (denyCache) return denyCache;
  const stored = await chrome.storage.local.get(DENY_KEY);
  denyCache = (stored[DENY_KEY] as DenyRule[] | undefined) ?? [];
  return denyCache;
}

export async function setDenylist(rules: DenyRule[]): Promise<void> {
  denyCache = rules;
  await chrome.storage.local.set({ [DENY_KEY]: rules });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && DENY_KEY in changes) denyCache = null;
});

export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith("*.")) {
    const bare = p.slice(2);
    return h === bare || h.endsWith(`.${bare}`);
  }
  return h === p;
}

export async function denyReason(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const rule of await getDenylist()) {
    if (!hostMatches(rule.host, parsed.hostname)) continue;
    if (rule.path && !parsed.pathname.startsWith(rule.path)) continue;
    return rule.note
      ? `${parsed.hostname} is on the local denylist: ${rule.note}`
      : `${parsed.hostname} is on the local denylist.`;
  }
  return null;
}

export async function assertAllowed(url: string): Promise<void> {
  const reason = await denyReason(url);
  if (reason) throw new PricklyError(reason, "blocked_url");
}

// ---------------------------------------------------------------------------
// TOCTOU
// ---------------------------------------------------------------------------

export function originOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Every mutating tool reads the tab, checks it, then acts. A page that
 * navigates itself in that window turns "click the accept button on
 * example.com" into "click whatever is now at those coordinates". Ten lines,
 * and it is the difference between a check and a decoration.
 */
export async function assertSameOrigin(
  tabId: number,
  originAtCheck: string,
  label: string,
): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const now = originOf(tab.url);
  if (now !== originAtCheck) {
    throw new PricklyError(
      `The page navigated from ${originAtCheck || "(none)"} to ${now || "(none)"} during ${label}. ` +
        `Nothing was done. Re-read the page before retrying.`,
      "navigated_away",
    );
  }
}

// ---------------------------------------------------------------------------
// Page settle
// ---------------------------------------------------------------------------

/**
 * Poll rather than sleep a fixed amount, so a fast page costs 100ms instead of
 * a second. Returns whether the page actually settled.
 */
export async function waitForSettle(tabId: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (tab.status !== "loading") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Settle after an action that might navigate.
 *
 * A click that follows a link does not flip tab.status to "loading" in the
 * same tick, so polling immediately sees the old page sitting at "complete",
 * declares it settled, and screenshots what was there before the click. Give
 * navigation a beat to start, then wait for it to finish.
 */
export async function settleAfterAction(tabId: number, timeoutMs = 5000): Promise<boolean> {
  const startedUrl = await currentUrl(tabId);

  // Poll briefly for navigation to begin; most clicks never navigate, so this
  // has to give up quickly rather than cost every action half a second.
  const startDeadline = Date.now() + 400;
  for (;;) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (tab.status === "loading" || tab.url !== startedUrl) break;
    if (Date.now() >= startDeadline) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return waitForSettle(tabId, timeoutMs);
}

async function currentUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|api[-_]?key|auth|credential|cookie|session[-_]?id|bearer|private[-_]?key/i;

export const REDACTED = "[redacted]";

/**
 * Walks a value and blanks anything that looks like a credential, so a
 * javascript_eval that happens to return a config object gives the agent the
 * shape without the secrets. Depth-limited because page objects are cyclic and
 * enormous.
 */
export function redact(value: unknown, depth = 5, seen = new WeakSet<object>()): unknown {
  if (depth <= 0) return "[depth limit]";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((v) => redact(v, depth - 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth - 1, seen);
  }
  return out;
}

/** Header lists come back as name/value pairs and need the same treatment. */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = SENSITIVE_KEY.test(name) ? REDACTED : value;
  }
  return out;
}

export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY.test(name);
}
