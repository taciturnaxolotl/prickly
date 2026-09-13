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

const STATE_COLOR: Record<SessionState, chrome.tabGroups.ColorEnum> = {
  idle: "grey",
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

const STORAGE_KEY = "sessions";

/** Write-through cache. chrome.storage.session survives service worker death. */
let cache: Map<string, Session> | null = null;

async function load(): Promise<Map<string, Session>> {
  if (cache) return cache;
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const list = (stored[STORAGE_KEY] as Session[] | undefined) ?? [];
  cache = new Map(list.map((s) => [s.sessionId, s]));
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await chrome.storage.session.set({ [STORAGE_KEY]: [...cache.values()] });
}

// ---------------------------------------------------------------------------
// Lookup and creation
// ---------------------------------------------------------------------------

export async function getSession(sessionId: string): Promise<Session | undefined> {
  const sessions = await load();
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  // The user can dissolve a group by dragging its last tab out. Notice that
  // rather than handing back a dead group id.
  try {
    await chrome.tabGroups.get(session.tabGroupId);
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

  const title = opts.title ?? `prickly ${opts.sessionId.slice(0, 8)}`;
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

  const tabGroupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
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
  if (ids.length) await chrome.tabs.remove(ids);
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
