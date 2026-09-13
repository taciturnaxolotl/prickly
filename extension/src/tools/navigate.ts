/**
 * Navigation.
 */

import { defineTool } from "../core/registry";
import { s } from "../core/schema";
import { PricklyError, text } from "@shared/protocol";
import { resolveTab } from "../core/sessions";
import { assertAllowed, assertDrivable, originOf, waitForSettle } from "../core/guards";
import { forgetGeometry } from "../core/screenshot";
import { forgetWorld, evalInPage } from "../core/page";

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
    const urlBefore = tab.url ?? "";

    if (isHistory) {
      await evalInPage(tab.id!, args.url === "back" ? "history.back()" : "history.forward()");
    } else {
      const target = resolveUrl(args.url, tab.url);
      assertDrivable(target);
      await assertAllowed(target);
      await chrome.tabs.update(tab.id!, { url: target });
    }

    forgetGeometry(tab.id!);
    forgetWorld(tab.id!);
    const settled = await waitForSettle(tab.id!, args.timeoutMs);
    const after = await chrome.tabs.get(tab.id!);

    // A single-page app can bounce a deep link to a different route, so a
    // requested URL that does not match where we landed is worth flagging
    // rather than reporting a bare success at the wrong page.
    const requested = isHistory ? null : resolveUrl(args.url, tab.url);
    const landed = after.url ?? "";
    const moved = stripHash(landed) !== stripHash(urlBefore);
    const wrongPlace = requested !== null && stripHash(requested) !== stripHash(landed);

    // A tab that never moved did not "redirect": the browser refused the URL.
    // Reporting that as a redirect sent agents off debugging the site instead
    // of the URL they asked for, so the two cases are now told apart.
    if (wrongPlace && !moved) {
      return text(
        `The browser refused to open ${requested}. The tab is still on ${landed}.`,
        `Schemes like data:, blob:, and javascript: cannot be navigated to directly; ` +
          `use javascript_eval to run code, or open a real http(s) URL.`,
      );
    }

    return text(
      settled
        ? `Navigated to ${landed}`
        : `Navigated to ${landed}, but the page was still loading after ${args.timeoutMs}ms. Re-read it before acting.`,
      wrongPlace ? `(note: the page redirected; you asked for ${requested})` : "",
      before !== originOf(after.url) ? `(origin changed: ${before} -> ${originOf(after.url)})` : "",
    );
  },
});

/** Compares URLs ignoring the fragment, which SPAs rewrite freely. */
function stripHash(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

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
