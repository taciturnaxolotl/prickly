/**
 * Resolves the real, user-facing name of the browser profile a host was
 * spawned for.
 *
 * Chromium tells a native messaging host almost nothing about its caller: the
 * argv carries the extension origin and nothing else, and forks like Dia and
 * Arc report a generic "Chrome" in the user agent, so the extension cannot
 * name its own profile. But the pieces to recover it are all on disk.
 *
 * The extension stores a unique browserId in its per-profile
 * chrome.storage.local, which lives in that profile's leveldb. So the profile
 * that owns this host is the one whose extension storage contains the browserId
 * the extension just reported. Find that directory, read its Preferences, and
 * out comes "Cedarville" instead of "Chrome".
 *
 * macOS only for now, keyed off the __CFBundleIdentifier the browser leaves in
 * the host's environment. Everything here is best effort: any miss falls back
 * to the name the extension already derived from the user agent.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * macOS bundle id -> the directory that holds the profile folders. Chrome and
 * its close forks put profiles directly under the app support folder; Dia and
 * Arc nest them under "User Data".
 */
const PROFILE_ROOTS: Record<string, string> = {
  "company.thebrowser.dia": "Dia/User Data",
  "company.thebrowser.Browser": "Arc/User Data",
  "com.google.Chrome": "Google/Chrome",
  "com.google.Chrome.beta": "Google/Chrome Beta",
  "com.google.Chrome.canary": "Google/Chrome Canary",
  "org.chromium.Chromium": "Chromium",
  "com.brave.Browser": "BraveSoftware/Brave-Browser",
  "com.microsoft.edgemac": "Microsoft Edge",
  "com.vivaldi.Vivaldi": "Vivaldi",
};

export interface ResolvedProfile {
  /** The user-facing profile name, e.g. "Cedarville". */
  name: string;
  /** The on-disk directory basename, e.g. "Profile 1". */
  directory: string;
  /** The real browser name from the bundle id, e.g. "Dia". */
  browser: string;
}

/** Bundle id -> the browser's real display name, since the UA can lie. */
const BROWSER_NAMES: Record<string, string> = {
  "company.thebrowser.dia": "Dia",
  "company.thebrowser.Browser": "Arc",
  "com.google.Chrome": "Chrome",
  "com.google.Chrome.beta": "Chrome Beta",
  "com.google.Chrome.canary": "Chrome Canary",
  "org.chromium.Chromium": "Chromium",
  "com.brave.Browser": "Brave",
  "com.microsoft.edgemac": "Edge",
  "com.vivaldi.Vivaldi": "Vivaldi",
};

function profileRoot(bundleId: string): string | null {
  const rel = PROFILE_ROOTS[bundleId];
  if (!rel) return null;
  return join(homedir(), "Library", "Application Support", rel);
}

/** The browser's real name from its bundle id, or null if unrecognized. */
export function browserName(bundleId: string | undefined): string | null {
  if (!bundleId) return null;
  return BROWSER_NAMES[bundleId] ?? null;
}

/** Reads profile.name out of a Chromium profile's Preferences file. */
function nameFromPreferences(profileDir: string): string | null {
  const prefs = join(profileDir, "Preferences");
  if (!existsSync(prefs)) return null;
  try {
    const data = JSON.parse(readFileSync(prefs, "utf8")) as {
      profile?: { name?: string };
    };
    return data.profile?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a profile's extension storage contains the browserId. The value sits
 * in a leveldb write-ahead log as a plain UTF-8 string, so a byte scan finds it
 * without a leveldb reader. Read as latin1 so the binary log never throws.
 */
function storageMentions(profileDir: string, extensionId: string, browserId: string): boolean {
  const dir = join(profileDir, "Local Extension Settings", extensionId);
  if (!existsSync(dir)) return false;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return false;
  }
  for (const file of files) {
    // The current write-ahead log and any compacted tables are where a value
    // lands; skip the lock and manifest bookkeeping.
    if (!file.endsWith(".log") && !file.endsWith(".ldb")) continue;
    try {
      if (readFileSync(join(dir, file), "latin1").includes(browserId)) return true;
    } catch {
      // Locked or vanished mid-read; treat as no match.
    }
  }
  return false;
}

/**
 * Finds the profile whose extension storage owns this browserId and returns its
 * real name. Null when it cannot be determined, so the caller keeps the
 * user-agent name.
 */
export function resolveProfile(
  bundleId: string | undefined,
  extensionId: string,
  browserId: string,
): ResolvedProfile | null {
  if (!bundleId) return null;
  const root = profileRoot(bundleId);
  if (!root || !existsSync(root)) return null;
  const browser = BROWSER_NAMES[bundleId] ?? "Unknown";

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }

  // "Default", "Profile 1", "Profile 3", ... Only real profile folders have a
  // Preferences file, which filters out Local State and the like.
  const profileDirs = entries.filter((entry) => {
    const full = join(root, entry);
    return existsSync(join(full, "Preferences"));
  });

  // The browserId match is exact and unique, so it disambiguates even when
  // several profiles have the extension installed.
  for (const entry of profileDirs) {
    const full = join(root, entry);
    if (storageMentions(full, extensionId, browserId)) {
      const name = nameFromPreferences(full);
      if (name) return { name, directory: entry, browser };
    }
  }

  // Exactly one profile has the extension at all: name it without needing the
  // storage match, which also covers a browserId not yet flushed to disk.
  const withExtension = profileDirs.filter((entry) =>
    existsSync(join(root, entry, "Local Extension Settings", extensionId)),
  );
  if (withExtension.length === 1) {
    const only = withExtension[0]!;
    const name = nameFromPreferences(join(root, only));
    if (name) return { name, directory: only, browser };
  }

  return null;
}
