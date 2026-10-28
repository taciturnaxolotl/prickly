/**
 * Browser registry.
 *
 * Chrome spawns one native host process per browser profile, and each of those
 * processes opens its own unix socket and writes a descriptor file next to it.
 * An agent connects by scanning the directory, which means no daemon, no
 * broker, and no coordination between profiles: run Dia and Chrome with two
 * profiles each and four sockets just appear.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type { BrowserIdentity } from "../../shared/protocol";
import { BROWSER_NAMES, resolveProfile, type ResolvedProfile } from "./profile";

/** The host knows its own browser; from outside, try each one we know. */
function resolveProfileAnywhere(extensionId: string, browserId: string): ResolvedProfile | null {
  for (const bundleId of Object.keys(BROWSER_NAMES)) {
    const found = resolveProfile(bundleId, extensionId, browserId);
    if (found) return found;
  }
  return null;
}

export interface BrowserDescriptor {
  browserId: string;
  profile: string;
  browser: string;
  browserVersion: string;
  platform: string;
  extensionId: string;
  protocolVersion: number;
  /** Unix socket path. */
  socket: string;
  pid: number;
  startedAt: number;
  hostVersion: string;
}

/**
 * Under ~/.local/state rather than $TMPDIR. macOS sweeps $TMPDIR files that
 * nobody has touched for three days, and a browser left open longer than that
 * lost its descriptor while the host kept running. The path has to stay short:
 * macOS caps unix socket paths at 104 bytes.
 */
export function registryDir(): string {
  const base = process.env.PRICKLY_SOCKET_DIR;
  if (base) return base;
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "prickly");
}

/** Where hosts from before the move still register. */
export function legacyRegistryDir(): string | null {
  if (process.env.PRICKLY_SOCKET_DIR) return null;
  const user = process.env.USER ?? process.env.LOGNAME ?? "unknown";
  return join(tmpdir(), `prickly-${user}`);
}

export function descriptorPath(browserId: string): string {
  return join(registryDir(), `${browserId}.json`);
}

export function socketPath(browserId: string): string {
  return join(registryDir(), `${browserId}.sock`);
}

export function ensureRegistryDir(): string {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeDescriptor(descriptor: BrowserDescriptor): void {
  const dir = ensureRegistryDir();
  const path = join(dir, `${descriptor.browserId}.json`);
  writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
}

export function removeDescriptor(browserId: string): void {
  rmSync(descriptorPath(browserId), { force: true });
  rmSync(socketPath(browserId), { force: true });
}

/** Whether a descriptor's process is still around. */
function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ListedBrowser extends BrowserDescriptor {
  /** Socket exists and the writing process is alive. */
  live: boolean;
}

/**
 * Reads every descriptor and prunes the ones whose host died without cleaning
 * up. Chrome kills native hosts hard on browser quit, so stale files are
 * normal rather than exceptional.
 */
export function listBrowsers(): ListedBrowser[] {
  const out = new Map<string, ListedBrowser>();
  for (const dir of [registryDir(), legacyRegistryDir()]) {
    if (!dir || !existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(dir, entry);
      let descriptor: BrowserDescriptor;
      try {
        descriptor = JSON.parse(readFileSync(path, "utf8")) as BrowserDescriptor;
      } catch {
        rmSync(path, { force: true });
        continue;
      }

      // A recovered descriptor has no pid; its socket answering is the proof.
      const live = descriptor.pid
        ? alive(descriptor.pid) && existsSync(descriptor.socket)
        : existsSync(descriptor.socket);
      if (!live) {
        rmSync(path, { force: true });
        if (descriptor.pid) rmSync(descriptor.socket, { force: true });
        continue;
      }
      if (!out.has(descriptor.browserId)) out.set(descriptor.browserId, { ...descriptor, live });
    }
  }

  // Most recently started first, so the default pick is the browser the
  // person is probably looking at.
  return [...out.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Rebuilds descriptors for sockets that lost theirs, by asking the browser
 * behind the socket who it is. A host that is still serving must never
 * vanish just because its descriptor file went missing.
 */
export async function recoverOrphans(
  probe: (socket: string) => Promise<BrowserIdentity | "dead" | "unknown">,
): Promise<void> {
  for (const dir of [registryDir(), legacyRegistryDir()]) {
    if (!dir || !existsSync(dir)) continue;
    const entries = new Set(readdirSync(dir));
    for (const entry of entries) {
      if (!entry.endsWith(".sock")) continue;
      const browserId = entry.slice(0, -".sock".length);
      const jsonPath = join(dir, `${browserId}.json`);
      let recovered = false;
      if (entries.has(`${browserId}.json`)) {
        try {
          recovered = !(JSON.parse(readFileSync(jsonPath, "utf8")) as BrowserDescriptor).pid;
        } catch {}
        if (!recovered) continue;
      }

      const socket = join(dir, entry);
      const identity = await probe(socket);
      // Leave the socket file alone even when nothing answers: deleting a
      // socket a host is still serving would cut that browser off for good.
      if (identity === "dead") {
        if (recovered) rmSync(jsonPath, { force: true });
        continue;
      }
      if (identity === "unknown" || recovered) continue;
      const resolved = resolveProfileAnywhere(identity.extensionId, identity.browserId);
      writeFileSync(
        jsonPath,
        `${JSON.stringify(
          {
            browserId: identity.browserId,
            profile: identity.label ?? resolved?.name ?? identity.profile,
            browser: resolved?.browser ?? identity.browser,
            browserVersion: identity.browserVersion,
            platform: identity.platform,
            extensionId: identity.extensionId,
            protocolVersion: identity.protocolVersion,
            socket,
            pid: 0,
            startedAt: Date.now(),
            hostVersion: "unknown",
          } satisfies BrowserDescriptor,
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    }
  }
}

/**
 * Resolves a browser by exact id, profile label, or a unique prefix of either.
 * Returns null when the name is ambiguous, which the caller reports rather
 * than guessing.
 */
export function resolveBrowser(
  name: string | undefined,
  browsers = listBrowsers(),
): ListedBrowser | null | ListedBrowser[] {
  if (!browsers.length) return null;
  if (!name) {
    // One browser: no ambiguity. Several: the caller must have set a default.
    return browsers.length === 1 ? browsers[0]! : null;
  }

  const needle = name.toLowerCase();
  const exact = browsers.filter(
    (b) => b.browserId.toLowerCase() === needle || b.profile.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0]!;

  const prefix = browsers.filter(
    (b) =>
      b.browserId.toLowerCase().startsWith(needle) ||
      b.profile.toLowerCase().startsWith(needle) ||
      b.browser.toLowerCase().startsWith(needle),
  );
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return prefix;
  return null;
}

export function describe(browser: BrowserIdentity): string {
  return `${browser.profile} (${browser.browser} ${browser.browserVersion}, ${browser.browserId.slice(0, 8)})`;
}
