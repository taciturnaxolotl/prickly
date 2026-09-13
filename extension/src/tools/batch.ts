/**
 * browser_batch.
 *
 * Sequential, stops on the first error, cannot nest. Coordinates inside a
 * batch refer to the screenshot taken before it started, since nothing in the
 * middle re-captures.
 *
 * Failures report exactly how far the batch got and what happened to the
 * results already collected, because "it failed somewhere" wastes a whole
 * turn of guessing.
 */

import { defineTool, executeTool, hasTool, isBatchable, makeContext } from "../core/registry";
import { s } from "../core/schema";
import { PricklyError, text, type ContentBlock, type ToolResult } from "@shared/protocol";
import { listTools } from "../core/registry";

const MAX_STEPS = 25;

/** Tools whose failure means the page state cannot be trusted afterwards. */
const HARD_FAILURES = new Set(["blocked_url", "navigated_away", "restricted_url", "tab_not_in_session"]);

defineTool({
  name: "browser_batch",
  description:
    "Runs several tools in one call, in order, stopping at the first failure. Coordinates refer to " +
    "the screenshot taken before the batch. Prefer this over one tool per turn when the steps do " +
    "not depend on reading each other's output.",
  input: {
    actions: s.array(
      s.object({
        name: s.string({ description: "Tool name. Must be batchable." }),
        input: s.any({ description: "Tool arguments object.", default: {} }),
      }),
      { description: "Steps to run, in order.", maxItems: MAX_STEPS },
    ),
  },
  async execute(args, ctx) {
    // Agents see these tools with an MCP prefix ("prickly_read_page"), so accept
    // that spelling here instead of reporting a name as unbatchable and then
    // listing it as batchable in the same breath.
    const steps = (args.actions as { name: string; input?: Record<string, unknown> }[]).map(
      (step) => ({ ...step, name: step.name.replace(/^prickly_/, "") }),
    );
    if (!steps.length) throw new PricklyError("browser_batch needs at least one action.", "bad_params");

    const nested = steps.find((step) => step.name === "browser_batch");
    if (nested) throw new PricklyError("browser_batch cannot nest.", "bad_params");

    const notBatchable = steps.filter((step) => !hasTool(step.name) || !isBatchable(step.name));
    if (notBatchable.length) {
      const batchable = listTools().filter((t) => t.batchable).map((t) => t.name).join(", ");
      throw new PricklyError(
        `${notBatchable.map((n) => n.name).join(", ")} cannot run inside a batch. ` +
          `Batchable: ${batchable}.`,
        "bad_params",
      );
    }

    const results: ToolResult[] = [];
    const blocks: ContentBlock[] = [];
    let failedAt = -1;
    let failure: string | null = null;
    let hardFailure = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const input = (step.input ?? {}) as Record<string, unknown>;
      const result = await executeTool({
        name: step.name,
        args: input,
        session: { sessionId: ctx.sessionId },
        client: ctx.client,
      });
      results.push(result);

      if (result.isError) {
        failedAt = i;
        failure = firstText(result) ?? "(no message)";
        hardFailure = HARD_FAILURES.has(guessCode(failure));
        break;
      }
      // Drop the per-step screenshots from the middle of a batch; keeping them
      // would blow the context window for no gain.
      blocks.push({ type: "text", text: `[${i}] ${step.name}: ${truncate(firstText(result) ?? "", 400)}` });
    }

    const completed = failedAt === -1 ? steps.length : failedAt;
    const remaining = steps.length - completed - (failedAt === -1 ? 0 : 1);

    if (failedAt === -1) {
      // Return the last screenshot only, which is the state after the batch.
      const last = results[results.length - 1];
      const images = last?.content.filter((c) => c.type === "image") ?? [];
      return {
        content: [...blocks, ...images],
        meta: { completed, total: steps.length },
      };
    }

    const summary = hardFailure
      ? `actions[${failedAt}] (${steps[failedAt]!.name}) failed: ${failure} ` +
        `(${completed} prior results discarded; ${remaining} not run)`
      : `actions[${failedAt}] (${steps[failedAt]!.name}) failed: ${failure} ` +
        `(${completed} completed, ${remaining} remaining)`;

    const content: ContentBlock[] = [{ type: "text", text: summary }];
    if (!hardFailure) {
      content.push(...blocks);
    } else {
      content.push({
        type: "text",
        text:
          `Prior results were discarded because the failure means the page state is not what the ` +
          `batch assumed. Re-read the page before retrying.`,
      });
    }

    return { content, isError: true, meta: { failedAt, completed, remaining, hardFailure } };
  },
});

function firstText(result: ToolResult): string | null {
  for (const block of result.content) {
    if (block.type === "text") return block.text;
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function guessCode(message: string): string {
  if (/denylist|blocked/i.test(message)) return "blocked_url";
  if (/navigated from/i.test(message)) return "navigated_away";
  if (/cannot be driven/i.test(message)) return "restricted_url";
  if (/not in this session/i.test(message)) return "tab_not_in_session";
  return "";
}

void makeContext;
