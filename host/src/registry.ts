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
 * Under /tmp rather than $XDG_RUNTIME_DIR because Chrome's native host runs
 * with a minimal environment and we want the agent CLI to find the same path
 * without guessing. World-readable, mode-restricted, and namespaced per user.
 */
export function registryDir(): string {
  const user = process.env.USER ?? process.env.LOGNAME ?? "unknown";
  const base = process.env.PRICKLY_SOCKET_DIR;
  if (base) return base;
  // macOS has no /run; tmpdir is the portable answer.
  void homedir;
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
  const dir = registryDir();
  if (!existsSync(dir)) return [];

  const out: ListedBrowser[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    let descriptor: BrowserDescriptor;
    try {
      descriptor = JSON.parse(readFileSync(join(dir, entry), "utf8")) as BrowserDescriptor;
    } catch {
      rmSync(join(dir, entry), { force: true });
      continue;
    }

    const live = alive(descriptor.pid) && existsSync(descriptor.socket);
    if (!live) {
      removeDescriptor(descriptor.browserId);
      continue;
    }
    out.push({ ...descriptor, live });
  }

  // Most recently started first, so the default pick is the browser the
  // person is probably looking at.
  return out.sort((a, b) => b.startedAt - a.startedAt);
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
