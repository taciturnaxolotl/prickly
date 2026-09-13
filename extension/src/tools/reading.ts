/**
 * Reading the page: accessibility tree, local element search, text, and a
 * JavaScript REPL.
 *
 * `find` is local scoring rather than a nested model call. The upstream
 * version bills a whole-page prompt to a small model on every lookup, which
 * buys fuzzy matching at the cost of a network dependency that fails when the
 * API is unreachable. Scoring against name, role, id, placeholder, and class
 * gets most of the way and costs nothing.
 */

import { defineTool } from "../core/registry";
import { s } from "../core/schema";
import { PricklyError, text } from "@shared/protocol";
import { resolveTab } from "../core/sessions";
import { assertDrivable, redact } from "../core/guards";
import { readText, readTree, searchPage } from "../core/page";
import { cdp } from "../core/cdp";

const DEFAULT_MAX_CHARS = 50_000;
const EVAL_TIMEOUT_MS = 45_000;

defineTool({
  name: "read_page",
  description:
    "Reads the accessibility tree and hands back element refs. Use filter: \"interactive\" to get " +
    "only controls, which is what you want before clicking or filling a form. Refs stay valid until " +
    "the page re-renders them away; a stale ref errors instead of guessing.",
  batchable: true,
  input: {
    tabId: s.number({ description: "Target tab.", integer: true, optional: true }),
    filter: s.enum_(["all", "interactive"] as const, {
      description: "\"interactive\" drops static text and containers.",
      default: "all",
    }),
    depth: s.number({ description: "Max tree depth.", integer: true, min: 1, max: 40, default: 15 }),
    ref: s.string({ description: "Read a subtree rooted at this ref instead of the whole page.", optional: true }),
    max_chars: s.number({
      description: "Character budget. Truncation happens at a line boundary and reports the true size.",
      integer: true,
      min: 500,
      max: 400_000,
      default: DEFAULT_MAX_CHARS,
    }),
    frameId: s.number({ description: "Read a specific frame instead of the top document.", integer: true, optional: true }),
  },
  async execute(args, ctx) {
    const session = await ctx.requireSession();
    const tab = await resolveTab(session, args.tabId);
    assertDrivable(tab.url);

    const result = await readTree(tab.id!, {
      maxDepth: args.depth,
      filter: args.filter,
      rootRef: args.ref,
      maxChars: args.max_chars,
    });

    const header = [
      `${result.title} — ${result.url}`,
      `${result.nodeCount} nodes${args.filter === "interactive" ? " (interactive only)" : ""}`,
    ];
    if (result.truncated) {
      header.push(
        `Truncated at ${args.max_chars} chars; the full tree is ${result.fullLength} chars. ` +
          `Raise max_chars or pass a ref to read a subtree.`,
      );
    }
    return text(...header, "", result.text);
  },
});

defineTool({
  name: "find",
  description:
    "Finds elements matching a query, best match first, with refs you can click or fill. " +
    "Tries role, accessible name, id, placeholder, href, and class. Up to 20 results.",
  batchable: true,
  input: {
    query: s.string({ description: "What you are looking for, e.g. \"submit button\" or \"search field\"." }),
    tabId: s.number({ description: "Target tab.", integer: true, optional: true }),
    limit: s.number({ description: "Max matches.", integer: true, min: 1, max: 20, default: 10 }),
  },
  async execute(args, ctx) {
    const session = await ctx.requireSession();
    const tab = await resolveTab(session, args.tabId);
    assertDrivable(tab.url);

    const { matches, scanned } = await searchPage(tab.id!, args.query, args.limit);
    if (!matches.length) {
      return text(
        `Nothing matched "${args.query}" out of ${scanned} candidate elements. ` +
          `Try read_page with filter:"interactive" to see what is actually there, or a shorter query.`,
      );
    }
    const lines = matches.map(
      (m) => `${m.ref} | ${m.role} | "${m.name || "(no name)"}" | ${m.detail}`,
    );
    return text(`${matches.length} match(es) for "${args.query}" out of ${scanned} candidates:`, ...lines);
  },
});

defineTool({
  name: "get_page_text",
  description:
    "Returns the visible text of the page with scripts and styles stripped. Cheaper than read_page " +
    "when you want content rather than controls. Use fromEnd to read the bottom of a long page " +
    "(newest chat messages, latest log lines) and offset to page through it.",
  batchable: true,
  input: {
    tabId: s.number({ description: "Target tab.", integer: true, optional: true }),
    max_chars: s.number({ description: "Character budget.", integer: true, min: 1, max: 400_000, default: DEFAULT_MAX_CHARS }),
    offset: s.number({ description: "Start this many characters in, to page through a long page.", integer: true, min: 0, default: 0 }),
    fromEnd: s.boolean({
      description:
        "Read the last max_chars of the page instead of the first. What you want when the newest " +
        "content is at the bottom, e.g. a chat log below a long sidebar.",
      default: false,
    }),
  },
  async execute(args, ctx) {
    const session = await ctx.requireSession();
    const tab = await resolveTab(session, args.tabId);
    assertDrivable(tab.url);

    const body = await readText(tab.id!);
    const header = `${tab.title} — ${tab.url}`;
    // Clamp rather than reject: a conservative number should not abort the rest
    // of a batch over a value we can simply honour.
    const budget = Math.max(200, args.max_chars);
    if (body.length <= budget && args.offset === 0) {
      return text(header, "", body);
    }

    let start: number;
    if (args.fromEnd) {
      start = Math.max(0, body.length - budget - args.offset);
    } else {
      start = Math.min(args.offset, body.length);
    }
    const slice = body.slice(start, start + budget);
    const end = start + slice.length;
    return text(
      header,
      `Showing chars ${start}-${end} of ${body.length}` +
        (args.fromEnd ? " (from the end)" : "") +
        (end < body.length && !args.fromEnd ? `; pass offset:${end} to continue` : "") +
        (start > 0 && args.fromEnd ? `; pass offset:${args.offset + slice.length} to read earlier` : ""),
      "",
      slice,
    );
  },
});

defineTool({
  name: "form_input",
  description:
    "Sets the value of an input, textarea, select, or contenteditable directly. Prefer this over " +
    "typing into a field: it is one call, it dispatches the input and change events frameworks need, " +
    "and it does not depend on focus.",
  batchable: true,
  mutating: true,
  input: {
    ref: s.string({ description: "Element ref from read_page or find." }),
    value: s.string({ description: "Value to set. For a select, an option's value or label. For a checkbox, \"true\"/\"false\"." }),
    tabId: s.number({ description: "Target tab.", integer: true, optional: true }),
  },
  async execute(args, ctx) {
    const session = await ctx.requireSession();
    const tab = await resolveTab(session, args.tabId);
    assertDrivable(tab.url);

    const { setRefValue } = await import("../core/page");
    await setRefValue(tab.id!, args.ref, args.value);
    return text(`Set ${args.ref} to ${args.value.length > 60 ? `${args.value.slice(0, 60)}...` : `"${args.value}"`}.`);
  },
});

defineTool({
  name: "javascript_eval",
  description:
    "Evaluates JavaScript in the page with REPL semantics: top-level await works and the last " +
    "expression is the result. Returned values are walked and anything that looks like a credential " +
    "is redacted, so dumping a config object is safe.",
  batchable: true,
  input: {
    text: s.string({ description: "JavaScript source." }),
    tabId: s.number({ description: "Target tab.", integer: true, optional: true }),
    redact: s.boolean({
      description:
        "Mask values that look like credentials. Off by default: this drives a browser you " +
        "control, so a token or cookie the page already holds is fair game. Set true to keep " +
        "secrets out of the transcript.",
      default: false,
    }),
  },
  async execute(args, ctx) {
    const session = await ctx.requireSession();
    const tab = await resolveTab(session, args.tabId);
    assertDrivable(tab.url);

    const session_ = cdp(tab.id!);
    await session_.enable("Runtime");

    const evaluate = async (expression: string) => {
      const result = await Promise.race([
        session_.send<{
          result: { type: string; subtype?: string; value?: unknown; description?: string };
          exceptionDetails?: { text: string; exception?: { description?: string } };
        }>("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          replMode: true,
          userGesture: true,
        }),
        sleep(EVAL_TIMEOUT_MS).then(() => null),
      ]);
      if (!result) throw new PricklyError(`javascript_eval timed out after ${EVAL_TIMEOUT_MS}ms.`, "timeout");
      return result;
    };

    let result = await evaluate(args.text);

    // A bare `return` at top level is legal in the REPL but not in evaluate.
    const errorText = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? "";
    if (errorText.includes("Illegal return statement")) {
      result = await evaluate(`(async () => { ${args.text} })()`);
    }

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      return {
        content: [{ type: "text", text: `Threw: ${detail}` }],
        isError: true,
      };
    }

    const value = args.redact ? redact(result.result.value) : result.result.value;
    const shown = value === undefined
      ? result.result.description ?? "undefined"
      : safeStringify(value);

    return {
      content: [{ type: "text", text: shown }],
      meta: { valueType: result.result.type, redacted: args.redact },
    };
  },
});

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
