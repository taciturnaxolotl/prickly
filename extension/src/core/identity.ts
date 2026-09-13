/**
 * Browser identity.
 *
 * Chrome spawns one native host process per profile, and the host names its
 * socket with a descriptor file. The agent needs to tell those processes
 * apart, so each browser gets a stable id generated once and kept in
 * chrome.storage.local, plus a human label you can rename from the options
 * page. "profile 2 of dia" beats "browser_a7f3".
 */

import { PROTOCOL_VERSION, type BrowserIdentity } from "@shared/protocol";

const ID_KEY = "browserId";
const LABEL_KEY = "profileLabel";

let cached: BrowserIdentity | null = null;

export async function identity(): Promise<BrowserIdentity> {
  if (cached) return cached;

  const stored = await chrome.storage.local.get([ID_KEY, LABEL_KEY]);
  let browserId = stored[ID_KEY] as string | undefined;
  if (!browserId) {
    browserId = crypto.randomUUID();
    await chrome.storage.local.set({ [ID_KEY]: browserId });
  }

  const ua = navigator.userAgent;
  const { browser, browserVersion } = detectBrowser(ua);
  const profile = (stored[LABEL_KEY] as string | undefined) ?? browser;

  cached = {
    browserId,
    browser,
    browserVersion,
    profile,
    extensionId: chrome.runtime.id,
    platform: navigator.platform || detectPlatform(ua),
    protocolVersion: PROTOCOL_VERSION,
  };
  return cached;
}

export async function setProfileLabel(label: string): Promise<void> {
  await chrome.storage.local.set({ [LABEL_KEY]: label });
  cached = null;
}

/**
 * Order matters: Dia, Arc, and Brave all report "Chrome" in the UA, so the
 * distinctive token has to be tested first.
 */
function detectBrowser(ua: string): { browser: string; browserVersion: string } {
  const candidates: [RegExp, string][] = [
    [/Dia\/([\d.]+)/, "Dia"],
    [/Arc\/([\d.]+)/, "Arc"],
    [/Brave\/([\d.]+)/, "Brave"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/Vivaldi\/([\d.]+)/, "Vivaldi"],
    [/Edg\/([\d.]+)/, "Edge"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/Chromium\/([\d.]+)/, "Chromium"],
    [/Chrome\/([\d.]+)/, "Chrome"],
  ];
  for (const [pattern, name] of candidates) {
    const m = ua.match(pattern);
    if (m) return { browser: name, browserVersion: m[1] ?? "" };
  }
  return { browser: "Unknown", browserVersion: "" };
}

function detectPlatform(ua: string): string {
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "unknown";
}

/** A short label for the socket descriptor: "dia" or "chrome". */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "browser";
}
