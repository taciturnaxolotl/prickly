/**
 * Navigation.
 */

import { defineTool } from "../core/registry";
import { s } from "../core/schema";
import { PricklyError, text } from "@shared/protocol";
import { resolveTab } from "../core/sessions";
import { assertAllowed, assertDrivable, originOf, waitForSettle } from "../core/guards";
import { forgetGeometry } from "../core/screenshot";

defineTool({
  name: "navigate",
  description:
    "Navigates a tab. Pass a URL, or \"back\" / \"forward\" with a tabId to use history. " +
    "Waits for the page to finish loading.",
  batchable: true,
  mutating: true,
  input: {
    url: s.string({
      description: "Absolute URL, or \"back\" / \"forward\". Relative URLs are resolved against the current page.",
    }),
    tabId: s.number({
      description: "Target tab. Required for back/forward; otherwise defaults to the session's active tab.",
      integer: true,
      optional: true,
    }),
    timeoutMs: s.number({ description: "Settle timeout.", integer: true, default: 8000, max: 60000 }),
  },
  async execute(args, ctx) {
    const session = await ctx.ensureSession();
    const isHistory = args.url === "back" || args.url === "forward";

    if (isHistory && args.tabId === undefined) {
      throw new PricklyError("back/forward needs an explicit tabId.", "bad_params");
    }

    const tab = await resolveTab(session, args.tabId);
    const before = originOf(tab.url);

    if (isHistory) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        args: [args.url],
        func: (direction: string) => {
          if (direction === "back") history.back();
          else history.forward();
        },
      });
    } else {
      const target = resolveUrl(args.url, tab.url);
      assertDrivable(target);
      await assertAllowed(target);
      await chrome.tabs.update(tab.id!, { url: target });
    }

    forgetGeometry(tab.id!);
    const settled = await waitForSettle(tab.id!, args.timeoutMs);
    const after = await chrome.tabs.get(tab.id!);

    return text(
      settled
        ? `Navigated to ${after.url}`
        : `Navigated to ${after.url}, but the page was still loading after ${args.timeoutMs}ms. Re-read it before acting.`,
      before !== originOf(after.url) ? `(origin changed: ${before} -> ${originOf(after.url)})` : "",
    );
  },
});

function resolveUrl(input: string, base: string | undefined): string {
  try {
    return new URL(input).href;
  } catch {
    // Relative to the current page.
  }
  if (!base) throw new PricklyError(`"${input}" is not an absolute URL and the tab has no page.`, "bad_params");
  try {
    return new URL(input, base).href;
  } catch {
    throw new PricklyError(`"${input}" is not a usable URL.`, "bad_params");
  }
}
