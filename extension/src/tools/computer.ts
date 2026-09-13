/**
 * The computer tool: screenshots, mouse, keyboard.
 *
 * Coordinates are always in screenshot space. A ref resolves to a viewport
 * point, which then gets mapped back into screenshot space so that every path
 * through this tool speaks the same coordinate system.
 */

import { defineTool } from "../core/registry";
import { s } from "../core/schema";
import { PricklyError, text, type ToolResult } from "@shared/protocol";
import { resolveTab } from "../core/sessions";
import {
  assertDrivable,
  assertSameOrigin,
  originOf,
  settleAfterAction,
} from "../core/guards";
import { capture, geometryFor, type Region } from "../core/screenshot";
import { refRect } from "../core/page";
import { cdp, sleep, takeDialogs } from "../core/cdp";
import {
  click,
  drag,
  forbiddenChord,
  hover,
  pressKeyChord,
  scroll,
  typeText,
} from "./input";

const ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "double_click",
  "triple_click",
  "hover",
  "left_click_drag",
  "type",
  "key",
  "scroll",
  "scroll_to",
  "wait",
  "wait_for_text",
] as const;

/** Converts a viewport-space point into the screenshot space the model sees. */
function toScreenshotSpace(tabId: number, x: number, y: number): [number, number] {
  const geo = geometryFor(tabId);
  if (!geo) return [Math.round(x), Math.round(y)];
  return [
    Math.round((x * geo.screenshotWidth) / geo.viewportWidth),
    Math.round((y * geo.screenshotHeight) / geo.viewportHeight),
  ];
}

interface ResolvedPoint {
  x: number;
  y: number;
  label: string;
  obscured: boolean;
}

/**
 * Every click and hover goes through here, so a ref and a raw coordinate
 * behave identically and a stale ref is an error rather than a misclick.
 */
async function resolvePoint(
  tabId: number,
  coordinate: [number, number] | undefined,
  ref: string | undefined,
  action: string,
): Promise<ResolvedPoint> {
  if (ref !== undefined) {
    const rect = await refRect(tabId, ref);
    const [x, y] = toScreenshotSpace(tabId, rect.x, rect.y);
    if (!rect.visible) {
      throw new PricklyError(
        `${ref} is covered by another element at its centre (${Math.round(rect.x)}, ${Math.round(rect.y)}). ` +
          `Something is on top of it; dismissing an overlay or scrolling may help. Nothing was clicked.`,
      );
    }
    return { x, y, label: ref, obscured: false };
  }
  if (coordinate !== undefined) {
    return { x: coordinate[0], y: coordinate[1], label: `(${coordinate[0]}, ${coordinate[1]})`, obscured: false };
  }
  throw new PricklyError(
    `${action} needs either a ref (from read_page or find) or a coordinate.`,
    "bad_params",
  );
}

defineTool({
  name: "computer",
  description:
    "Screenshots, clicks, typing, scrolling, and waiting. Coordinates are in screenshot space, " +
    "or pass a ref from read_page/find to target an element directly. Take a screenshot first; " +
    "clicking from memory of an earlier screenshot is how misclicks happen.",
  mutating: true,
  input: {
    action: s.enum_(ACTIONS, { description: "What to do." }),
    tabId: s.number({ description: "Target tab. Defaults to the session's active tab.", integer: true, optional: true }),
    coordinate: s.point({ description: "[x, y] in screenshot space.", optional: true }),
    ref: s.string({ description: "Element ref from read_page or find. Preferred over coordinate.", optional: true }),
    text: s.string({ description: "For type: the text. For wait_for_text: the substring to wait for.", optional: true }),
    key: s.string({
      description:
        "For key: a chord like \"enter\", \"cmd+l\", \"shift+arrowleft\". Space-separated for a sequence. Page zoom chords are refused.",
      optional: true,
    }),
    repeat: s.number({ description: "Repeat count for key, max 100.", integer: true, min: 1, max: 100, default: 1 }),
    scroll_direction: s.enum_(["up", "down", "left", "right"] as const, { description: "For scroll.", optional: true }),
    scroll_amount: s.number({ description: "Scroll distance in pixels.", integer: true, min: 1, default: 400 }),
    coordinate_end: s.point({ description: "For left_click_drag: the drop point.", optional: true }),
    ref_end: s.string({ description: "For left_click_drag: drop target as a ref.", optional: true }),
    duration: s.number({ description: "For wait: seconds, max 30.", min: 0, max: 30, default: 1 }),
    timeoutMs: s.number({ description: "For wait_for_text: max wait.", integer: true, default: 10000, max: 30000 }),
    region: s.object(
      {
        x: s.number({ description: "Left edge in screenshot space." }),
        y: s.number({ description: "Top edge in screenshot space." }),
        width: s.number({ description: "Region width.", min: 1 }),
        height: s.number({ description: "Region height.", min: 1 }),
      },
      { description: "For screenshot: capture part of the page at full quality.", optional: true },
    ),
    fullQuality: s.boolean({ description: "Skip the token-budget downscale.", default: false }),
    modifiers: s.string({ description: "Chord to hold during the click, e.g. \"shift\" or \"cmd+shift\".", optional: true }),
  },
  async execute(args, ctx): Promise<ToolResult> {
    const session = await ctx.ensureSession();
    const tab = await resolveTab(session, args.tabId);
    const tabId = tab.id!;

    assertDrivable(tab.url);

    // Anything that touches the page checks the origin twice: once before the
    // permission-free guard work, and once right before acting. The second
    // check is the one that catches a page navigating itself mid-tool.
    const originAtStart = originOf(tab.url);
    const mutating = args.action !== "screenshot" && args.action !== "wait";
    if (mutating) await assertSameOrigin(tabId, originAtStart, args.action);

    const notes: string[] = [];
    const dialogsBefore = takeDialogs(tabId).length;

    switch (args.action) {
      case "screenshot":
        return await doScreenshot(tabId, args, notes, dialogsBefore);

      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click": {
        const point = await resolvePoint(tabId, args.coordinate, args.ref, args.action);
        await click(tabId, {
          x: point.x,
          y: point.y,
          button: args.action === "right_click" ? "right" : "left",
          clickCount: args.action === "double_click" ? 2 : args.action === "triple_click" ? 3 : 1,
          modifiers: args.modifiers,
        });
        notes.push(`${args.action} at ${point.label}`);
        break;
      }

      case "hover": {
        const point = await resolvePoint(tabId, args.coordinate, args.ref, "hover");
        await hover(tabId, point.x, point.y, args.modifiers);
        notes.push(`hover over ${point.label}`);
        break;
      }

      case "left_click_drag": {
        const from = await resolvePoint(tabId, args.coordinate, args.ref, "left_click_drag");
        const to = await resolvePoint(
          tabId,
          args.coordinate_end,
          args.ref_end,
          "left_click_drag (drop)",
        );
        await drag(tabId, { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
        notes.push(`dragged ${from.label} to ${to.label}`);
        break;
      }

      case "type": {
        if (args.text === undefined) throw new PricklyError("type needs text.", "bad_params");
        await typeText(tabId, args.text);
        notes.push(`typed ${args.text.length} characters`);
        break;
      }

      case "key": {
        if (!args.key) throw new PricklyError("key needs a key chord.", "bad_params");
        for (const chord of args.key.split(/\s+/).filter(Boolean)) {
          const refused = forbiddenChord(chord);
          if (refused) throw new PricklyError(refused, "bad_params");
          await pressKeyChord(tabId, chord, args.repeat);
          if (args.repeat > 1) notes.push(`${chord} x${args.repeat}`);
          else notes.push(chord);
        }
        break;
      }

      case "scroll": {
        const point = args.coordinate
          ? { x: args.coordinate[0], y: args.coordinate[1] }
          : args.ref
            ? await refPoint(tabId, args.ref)
            : centreOf(tabId);
        const amount = args.scroll_amount;
        const dir = args.scroll_direction ?? "down";
        const [dx, dy] =
          dir === "down" ? [0, amount]
          : dir === "up" ? [0, -amount]
          : dir === "right" ? [amount, 0]
          : [-amount, 0];
        await scroll(tabId, point.x, point.y, dx, dy);
        notes.push(`scrolled ${dir} by ${amount}`);
        break;
      }

      case "scroll_to": {
        if (!args.ref) throw new PricklyError("scroll_to needs a ref.", "bad_params");
        await refRect(tabId, args.ref); // scrolls into view as a side effect
        await sleep(150);
        notes.push(`scrolled to ${args.ref}`);
        break;
      }

      case "wait":
        await sleep(Math.min(args.duration, 30) * 1000);
        notes.push(`waited ${args.duration}s`);
        break;

      case "wait_for_text": {
        if (!args.text) throw new PricklyError("wait_for_text needs text.", "bad_params");
        const found = await waitForText(tabId, args.text, args.timeoutMs);
        notes.push(found ? `found "${args.text}"` : `"${args.text}" never appeared within ${args.timeoutMs}ms`);
        if (!found) notes.push("Continuing anyway; the page may still be working.");
        break;
      }
    }

    /**
     * Navigation is checked but not refused.
     *
     * The origin guard before the action is the real TOCTOU protection: it
     * makes sure the page is what we thought it was at the moment we act.
     * Afterwards, a changed origin is usually the whole point of the click, so
     * it gets reported rather than treated as a violation.
     */
    const settled = await settleAfterAction(tabId);
    if (!settled) notes.push("the page was still loading when this returned");

    const endTab = await chrome.tabs.get(tabId);
    const originAtEnd = originOf(endTab.url);
    if (mutating && originAtEnd !== originAtStart) {
      notes.push(`this navigated to ${originAtEnd}; refs from the old page are stale`);
    }

    const dialogs = takeDialogs(tabId).slice(dialogsBefore);
    for (const d of dialogs) {
      notes.push(
        `a ${d.type} dialog was intercepted and ${d.accepted ? "accepted" : "dismissed"}` +
          (d.message ? ` ("${d.message.slice(0, 80)}")` : ""),
      );
    }

    // Return a screenshot with every action. An agent that cannot see the
    // result of its own click will spend a turn asking for one.
    const shot = await capture(tabId);
    return {
      content: [
        { type: "text", text: notes.join("; ") },
        { type: "image", data: shot.data, mimeType: shot.mimeType },
      ],
      meta: {
        screenshot: { width: shot.width, height: shot.height, quality: shot.quality, scaled: shot.scaled },
        url: (await chrome.tabs.get(tabId)).url,
        dialogs: dialogs.length,
      },
    };
  },
});

async function refPoint(tabId: number, ref: string): Promise<{ x: number; y: number }> {
  const rect = await refRect(tabId, ref);
  const [x, y] = toScreenshotSpace(tabId, rect.x, rect.y);
  return { x, y };
}

function centreOf(tabId: number): { x: number; y: number } {
  const geo = geometryFor(tabId);
  if (geo) return { x: Math.round(geo.screenshotWidth / 2), y: Math.round(geo.screenshotHeight / 2) };
  return { x: 400, y: 300 };
}

async function doScreenshot(
  tabId: number,
  args: { region?: { x: number; y: number; width: number; height: number }; fullQuality?: boolean },
  notes: string[],
  dialogsBefore: number,
): Promise<ToolResult> {
  let region: Region | undefined;
  if (args.region) {
    // Region coordinates arrive in screenshot space; convert to viewport.
    const geo = geometryFor(tabId);
    const scaleX = geo ? geo.viewportWidth / geo.screenshotWidth : 1;
    const scaleY = geo ? geo.viewportHeight / geo.screenshotHeight : 1;
    region = {
      x: Math.round(args.region.x * scaleX),
      y: Math.round(args.region.y * scaleY),
      width: Math.round(args.region.width * scaleX),
      height: Math.round(args.region.height * scaleY),
    };
  }

  const shot = await capture(tabId, { region, fullQuality: args.fullQuality });
  const tab = await chrome.tabs.get(tabId);

  const lines = [
    `${region ? "Region" : "Full page"} screenshot: ${shot.width}x${shot.height}` +
      (shot.scaled ? ` (scaled to fit the token budget, JPEG q=${shot.quality.toFixed(2)})` : ""),
    `URL: ${tab.url}`,
    `Title: ${tab.title}`,
  ];
  if (!region) {
    lines.push(
      `Coordinates in this image map to the page 1:1 from now on. ` +
        `A click at (x, y) here lands at the right place.`,
    );
  }

  const dialogs = takeDialogs(tabId).slice(dialogsBefore);
  for (const d of dialogs) {
    lines.push(`Note: a ${d.type} dialog was intercepted and ${d.accepted ? "accepted" : "dismissed"}.`);
  }
  void notes;

  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "image", data: shot.data, mimeType: shot.mimeType },
    ],
    meta: {
      screenshot: { width: shot.width, height: shot.height, quality: shot.quality, scaled: shot.scaled },
      region: region ?? null,
    },
  };
}

async function waitForText(tabId: number, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const lower = needle.toLowerCase();
  for (;;) {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [lower],
      func: (n: string) => document.body?.innerText?.toLowerCase().includes(n) ?? false,
    });
    if (frame?.result === true) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/** Re-exported so batch can reuse the dialog reporting. */
export { takeDialogs };
export { cdp };
