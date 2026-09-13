/**
 * Sessions and tab-group isolation.
 *
 * Each agent session owns exactly one Chrome tab group. Tools refuse tab ids
 * outside the group, which is the whole security story that matters day to
 * day: an agent cannot touch your banking tab because it is not in the group,
 * and no policy engine is needed to say so.
 *
 * The tab group is also the status display. Chrome gives you two channels on a
 * group, title and colour; colour is the one built for state, so state lives
 * there and the title stays a plain readable session name.
 */

import { PricklyError } from "@shared/protocol";

export type SessionState = "idle" | "running" | "attention" | "done";

/**
 * State lives in the group colour, which is one of only three things an
 * extension can set on a tab group (title, colour, collapsed) and the one
 * built to carry status. Grey is deliberately unused: it reads as "no colour"
 * next to the user's own groups, so an idle agent would look like a glitch
 * rather than a deliberate, resting session.
 */
const STATE_COLOR: Record<SessionState, chrome.tabGroups.ColorEnum> = {
  idle: "purple",
  running: "blue",
  attention: "red",
  done: "green",
};

export interface Session {
  sessionId: string;
  tabGroupId: number;
  windowId: number;
  title: string;
  createdAt: number;
  state: SessionState;
}

/**
 * A short, distinctive label for a session id like "agent-68262-okh6".
 *
 * Truncating the front collides badly: several agents started from the same
 * process family share a "agent-68" prefix and every group ends up with the
 * same name. The last segment is the random part, so it is the one that
 * actually tells two sessions apart at a glance.
 */
function shortLabel(sessionId: string): string {
  const parts = sessionId.split(/[-:]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? sessionId;
  return last.length >= 3 ? last : sessionId.slice(-6);
}

const STORAGE_KEY = "sessions";

/**
 * Write-through cache, persisted in storage.local rather than storage.session.
 *
 * storage.session is wiped when the extension reloads, which orphaned every
 * tab group it had created: the groups stayed in the browser but the extension
 * no longer knew they were its own, so nothing could ever close them. local
 * survives a reload, so a previous life's groups remain reclaimable.
 */
let cache: Map<string, Session> | null = null;

async function load(): Promise<Map<string, Session>> {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const list = (stored[STORAGE_KEY] as Session[] | undefined) ?? [];
  cache = new Map(list.map((s) => [s.sessionId, s]));
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await chrome.storage.local.set({ [STORAGE_KEY]: [...cache.values()] });
}

// ---------------------------------------------------------------------------
// Lookup and creation
// ---------------------------------------------------------------------------

export async function getSession(sessionId: string): Promise<Session | undefined> {
  const sessions = await load();
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  // A session dies two ways. The user drags out its last tab, dissolving the
  // group. Or, on Dia and other browsers that suspend a profile when you swipe
  // away from it, the group id can still resolve while every tab under it is
  // frozen and throws "Tab not found for session ID" on first touch. Validate
  // both the group and that at least one real tab answers, so a stale session
  // is discarded here rather than erroring inside the tool that used it.
  try {
    await chrome.tabGroups.get(session.tabGroupId);
    const tabs = await chrome.tabs.query({ groupId: session.tabGroupId });
    if (tabs.length === 0) throw new Error("group has no live tabs");
    // Touch one tab to force the suspended-profile error to surface now.
    if (tabs[0]?.id !== undefined) await chrome.tabs.get(tabs[0].id);
    return session;
  } catch {
    sessions.delete(sessionId);
    await persist();
    return undefined;
  }
}

export async function requireSession(sessionId: string): Promise<Session> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new PricklyError(
      `No tab group for session ${sessionId}. Call tabs_context with createIfEmpty: true first.`,
      "no_such_session",
    );
  }
  return session;
}

export interface CreateSessionOptions {
  sessionId: string;
  title?: string;
  /**
   * Open a separate window instead of grouping a tab in the current one.
   *
   * Defaults to false. CDP input is delivered to the tab's renderer directly,
   * not through the window's focus chain, so a background tab clicks and types
   * exactly like a foreground one. Measured, because the opposite looks true
   * when something else is broken: a hidden tab reports
   * `visibilityState: "hidden"` and still navigates on click.
   */
  newWindow?: boolean;
  url?: string;
}

export async function createSession(opts: CreateSessionOptions): Promise<Session> {
  const sessions = await load();
  const existing = await getSession(opts.sessionId);
  if (existing) return existing;

  const title = opts.title ?? `prickly ${shortLabel(opts.sessionId)}`;
  const url = opts.url ?? "about:blank";

  let tabId: number;
  let windowId: number;
  if (opts.newWindow === true) {
    const window = await chrome.windows.create({ url, focused: false });
    const tab = window?.tabs?.[0];
    if (!window?.id || !tab?.id) {
      throw new PricklyError("Could not open a window for the session");
    }
    windowId = window.id;
    tabId = tab.id;
  } else {
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id || tab.windowId === undefined) {
      throw new PricklyError("Could not open a tab for the session");
    }
    tabId = tab.id;
    windowId = tab.windowId;
  }

  // Grouping can fail on a suspended profile ("Tab not found for session ID"),
  // and a half-created session would otherwise leave the tab orphaned. Clean
  // it up and report the real reason.
  let tabGroupId: number;
  try {
    tabGroupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  } catch (err) {
    await removeTabsPreservingFocus([tabId]);
    throw new PricklyError(
      `Could not create a tab group: ${String((err as Error)?.message ?? err)}. ` +
        `On a browser that suspends background profiles (Dia), a session must be created while ` +
        `its profile is the active one; after that it can be driven from the background.`,
      "internal",
    );
  }
  const session: Session = {
    sessionId: opts.sessionId,
    tabGroupId,
    windowId,
    title,
    createdAt: Date.now(),
    state: "idle",
  };
  sessions.set(session.sessionId, session);
  await persist();
  await updateGroup(session);
  return session;
}

export async function closeSession(sessionId: string): Promise<void> {
  const sessions = await load();
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  await persist();
  if (!session) return;
  const tabs = await chrome.tabs.query({ groupId: session.tabGroupId });
  const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
  await removeTabsPreservingFocus(ids);
}

/**
 * Closes tabs without moving the user.
 *
 * Chrome activates a neighbouring tab whenever the active one goes away, so
 * cleaning up agent tabs would yank whoever is working in that window to some
 * unrelated page. Note what was active first and put it back afterwards.
 *
 * Window focus is deliberately left alone: raising the browser would be worse
 * than the problem, since the person may be in another app entirely.
 */
export async function removeTabsPreservingFocus(tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  const doomed = new Set(tabIds);
  const activeBefore = await chrome.tabs.query({ active: true }).catch(() => []);

  await chrome.tabs.remove(tabIds).catch(() => {});

  for (const tab of activeBefore) {
    if (tab.id === undefined || doomed.has(tab.id)) continue;
    try {
      const still = await chrome.tabs.get(tab.id);
      if (!still.active) await chrome.tabs.update(tab.id, { active: true });
    } catch {
      // The tab the user was on has since gone; nothing to restore.
    }
  }
}

export async function listSessions(): Promise<Session[]> {
  const sessions = await load();
  const alive: Session[] = [];
  for (const session of sessions.values()) {
    try {
      await chrome.tabGroups.get(session.tabGroupId);
      alive.push(session);
    } catch {
      sessions.delete(session.sessionId);
    }
  }
  await persist();
  return alive;
}

// ---------------------------------------------------------------------------
// Tab membership
// ---------------------------------------------------------------------------

export async function sessionTabs(session: Session): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ groupId: session.tabGroupId });
}

export async function requireTabInSession(
  session: Session,
  tabId: number,
): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new PricklyError(`Tab ${tabId} does not exist.`, "no_such_tab");
  }
  if (tab.groupId !== session.tabGroupId) {
    throw new PricklyError(
      `Tab ${tabId} is not in this session's tab group. ` +
        `Only tabs in group ${session.tabGroupId} can be driven; call tabs_context to list them.`,
      "tab_not_in_session",
    );
  }
  return tab;
}

/**
 * Tools take an optional tabId. With one tab in the group the answer is
 * obvious, with several it is not, and guessing is how an agent types into the
 * wrong page.
 */
export async function resolveTab(
  session: Session,
  tabId?: number,
): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) return requireTabInSession(session, tabId);

  const tabs = await sessionTabs(session);
  if (tabs.length === 0) {
    throw new PricklyError(
      "This session's tab group has no tabs. Call tabs_create first.",
      "no_such_tab",
    );
  }
  if (tabs.length === 1) return tabs[0]!;

  const active = tabs.find((t) => t.active);
  if (active) return active;

  throw new PricklyError(
    `This session has ${tabs.length} tabs and none is active. Pass tabId explicitly ` +
      `(${tabs.map((t) => t.id).join(", ")}).`,
    "bad_params",
  );
}

// ---------------------------------------------------------------------------
// Group appearance
// ---------------------------------------------------------------------------

export async function setSessionState(
  sessionId: string,
  state: SessionState,
): Promise<void> {
  const sessions = await load();
  const session = sessions.get(sessionId);
  if (!session || session.state === state) return;
  session.state = state;
  await persist();
  await updateGroup(session);
}

/**
 * chrome.tabGroups.update races the user dragging tabs around, and loses.
 * Three tries at 500ms covers a drag.
 */
async function updateGroup(session: Session): Promise<void> {
  const props: chrome.tabGroups.UpdateProperties = {
    title: session.title,
    color: STATE_COLOR[session.state],
    collapsed: session.state === "done",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabGroups.update(session.tabGroupId, props);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Runs work with the group showing "running", then settling back to idle. */
export async function withRunningState<T>(
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  await setSessionState(sessionId, "running");
  try {
    const result = await work();
    await setSessionState(sessionId, "idle");
    return result;
  } catch (err) {
    await setSessionState(sessionId, "attention");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Closes sessions recorded by a previous life of the extension.
 *
 * A session only means anything while the agent that opened it is connected.
 * After a reload or a browser restart no agent is attached to the old groups,
 * so they are litter by definition: close them rather than leave tab groups
 * the user has to tidy by hand.
 */
export async function reapOrphanSessions(): Promise<number> {
  const sessions = await load();
  const ids = [...sessions.keys()];
  let closed = 0;
  for (const id of ids) {
    try {
      await closeSession(id);
      closed++;
    } catch {
      // Group already gone; the record is dropped either way.
    }
  }
  return closed;
}

/**
 * Closes the sessions belonging to one agent, called when its connection drops.
 * An agent that crashed or timed out never gets to call session_close itself,
 * and that was the main source of abandoned tab groups.
 */
export async function closeSessionsForClient(sessionIds: string[]): Promise<number> {
  let closed = 0;
  for (const id of sessionIds) {
    const existing = await getSession(id);
    if (!existing) continue;
    await closeSession(id).catch(() => {});
    closed++;
  }
  return closed;
}

/**
 * Closes tab groups directly, for tidying up groups whose session record was
 * lost (an older extension build stored sessions somewhere a reload wiped).
 * Without an explicit list this only touches groups whose title we set, so a
 * user's own groups are never collateral.
 */
export async function sweepGroups(groupIds?: number[]): Promise<number> {
  let targets: number[];
  if (groupIds?.length) {
    targets = groupIds;
  } else {
    const groups = await chrome.tabGroups.query({});
    targets = groups
      .filter((g) => (g.title ?? "").startsWith("prickly "))
      .map((g) => g.id);
  }

  let closed = 0;
  for (const groupId of targets) {
    try {
      const tabs = await chrome.tabs.query({ groupId });
      const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
      await removeTabsPreservingFocus(ids);
      closed++;
    } catch {
      // Already gone.
    }
  }

  // Drop any session records pointing at groups we just closed.
  const sessions = await load();
  for (const [id, s] of [...sessions]) {
    if (targets.includes(s.tabGroupId)) sessions.delete(id);
  }
  await persist();
  return closed;
}
