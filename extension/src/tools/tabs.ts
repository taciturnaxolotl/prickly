/**
 * Tab and session tools.
 *
 * tabs_context is the first thing an agent calls, and it is also the place
 * where the isolation boundary gets established: everything after it is
 * scoped to one tab group.
 */

import { defineTool } from "../core/registry";
import { s } from "../core/schema";
import { text } from "@shared/protocol";
import {
  closeSession,
  createSession,
  getSession,
  listSessions,
  sessionTabs,
} from "../core/sessions";
import { assertAllowed, assertDrivable } from "../core/guards";
import { geometryFor, forgetGeometry } from "../core/screenshot";
import { forget as forgetNetwork } from "../core/network";

defineTool({
  name: "tabs_context",
  description:
    "Lists the tabs in this session's tab group. Call this first; every other tool is " +
    "scoped to the group. Pass createIfEmpty to open a group when there is not one yet.",
  batchable: true,
  input: {
    createIfEmpty: s.boolean({
      description: "Create a tab group if this session has none.",
      default: false,
    }),
    newWindow: s.boolean({
      description:
        "Open the group in its own window instead of the current one. Off by default: a " +
        "background tab can be driven just as well, and taking a window interrupts the user.",
      default: false,
    }),
    url: s.string({ description: "URL to open when creating the group.", optional: true }),
  },
  async execute(args, ctx) {
    let session = await getSession(ctx.sessionId);

    if (!session) {
      if (!args.createIfEmpty) {
        return {
          content: [
            {
              type: "text",
              text:
                `No tab group for this session. ` +
                `Call tabs_context with createIfEmpty: true to open one.`,
            },
          ],
        };
      }
      if (args.url) {
        assertDrivable(args.url);
        await assertAllowed(args.url);
      }
      session = await createSession({
        sessionId: ctx.sessionId,
        url: args.url,
        newWindow: args.newWindow,
      });
    }

    const tabs = await sessionTabs(session);
    if (!tabs.length) {
      return text(
        `Session ${session.sessionId} has tab group ${session.tabGroupId} with no tabs. ` +
          `Call tabs_create to open one.`,
      );
    }

    const lines = tabs.map((tab) => {
      const geo = geometryFor(tab.id!);
      const marker = tab.active ? "*" : " ";
      const shot = geo ? ` (last screenshot ${geo.screenshotWidth}x${geo.screenshotHeight})` : "";
      return `${marker} tabId=${tab.id} ${tab.title ?? "(untitled)"} — ${tab.url ?? ""}${shot}`;
    });

    return text(
      `Session: ${session.sessionId}`,
      `Tab group: ${session.tabGroupId} (state: ${session.state}), window ${session.windowId}`,
      `Tabs:`,
      ...lines,
      ``,
      `Coordinates from screenshots are in screenshot space and map back automatically. ` +
        `Only these tab ids can be driven.`,
    );
  },
});

defineTool({
  name: "tabs_create",
  description: "Opens a new tab inside this session's tab group.",
  batchable: true,
  mutating: true,
  input: {
    url: s.string({ description: "URL to open. Defaults to about:blank.", optional: true }),
    active: s.boolean({ description: "Bring the tab to the front.", default: false }),
  },
  async execute(args, ctx) {
    const session = await ctx.ensureSession();
    const url = args.url ?? "about:blank";
    assertDrivable(url);
    await assertAllowed(url);

    const tab = await chrome.tabs.create({
      url,
      active: args.active,
      windowId: session.windowId,
    });
    await chrome.tabs.group({ tabIds: [tab.id!], groupId: session.tabGroupId });
    return text(`Opened tab ${tab.id}: ${url}`);
  },
});

defineTool({
  name: "tabs_close",
  description:
    "Closes a tab in this session's group. Closing the last one removes the group.",
  batchable: true,
  mutating: true,
  input: {
    tabId: s.number({ description: "Tab to close.", integer: true }),
  },
  async execute(args, ctx) {
    const session = await ctx.requireSession();
    const tabs = await sessionTabs(session);
    if (!tabs.some((t) => t.id === args.tabId)) {
      return {
        content: [
          {
            type: "text",
            text: `Tab ${args.tabId} is not in this session's group. Tabs: ${tabs
              .map((t) => t.id)
              .join(", ") || "(none)"}`,
          },
        ],
        isError: true,
      };
    }
    await chrome.tabs.remove(args.tabId);
    forgetGeometry(args.tabId);
    forgetNetwork(args.tabId);
    return text(`Closed tab ${args.tabId}.`);
  },
});

defineTool({
  name: "sessions_list",
  description:
    "Lists every agent session (tab group) in this browser profile, including ones from " +
    "other clients. Useful when you need to find a group you opened earlier.",
  batchable: true,
  input: {},
  async execute() {
    const sessions = await listSessions();
    if (!sessions.length) return text("No sessions in this browser.");
    const lines = sessions.map((s_) => {
      const age = Math.round((Date.now() - s_.createdAt) / 1000);
      return `- ${s_.sessionId} "${s_.title}" group=${s_.tabGroupId} state=${s_.state} age=${age}s`;
    });
    return text(`Sessions in this browser profile:`, ...lines);
  },
});

defineTool({
  name: "session_close",
  description: "Closes this session's tab group and all of its tabs.",
  mutating: true,
  input: {},
  async execute(_args, ctx) {
    await closeSession(ctx.sessionId);
    return text(`Closed session ${ctx.sessionId} and its tab group.`);
  },
});

defineTool({
  name: "resize_window",
  description:
    "Resizes the browser window containing a tab. Use this to change the viewport before " +
    "taking a screenshot, since screenshot geometry follows the viewport.",
  batchable: true,
  mutating: true,
  input: {
    width: s.number({ description: "Window width in CSS pixels.", integer: true, min: 200, max: 4000 }),
    height: s.number({ description: "Window height in CSS pixels.", integer: true, min: 200, max: 4000 }),
    tabId: s.number({ description: "A tab in the window to resize.", integer: true }),
  },
  async execute(args, ctx) {
    const session = await ctx.requireSession();
    const tabs = await sessionTabs(session);
    if (!tabs.some((t) => t.id === args.tabId)) {
      throw new Error(`Tab ${args.tabId} is not in this session's group.`);
    }
    const tab = await chrome.tabs.get(args.tabId);
    await chrome.windows.update(tab.windowId!, {
      width: args.width,
      height: args.height,
    });
    forgetGeometry(args.tabId);
    return text(`Resized window ${tab.windowId} to ${args.width}x${args.height}. Take a new screenshot.`);
  },
});
