/**
 * Tool registry and dispatch.
 *
 * One entry point, `executeTool`, sits between the wire and every tool. It
 * validates arguments, resolves the session lazily, keeps the tab group's
 * colour honest, and turns thrown errors into a result the model can read
 * instead of a stack trace.
 */

import {
  PricklyError,
  errorResult,
  type ToolResult,
  type ToolSchema,
  type SessionRef,
} from "@shared/protocol";
import { ValidationError, objectSchemaJSON, type Schema } from "./schema";
import {
  createSession,
  requireSession,
  setSessionState,
  type Session,
} from "./sessions";

export interface ToolContext {
  /** Always present; the session may not exist in the browser yet. */
  sessionId: string;
  /** Free-form client label from the host, for logs. */
  client: string;
  /** Unique per tool call. Screenshot contexts and captures key off this. */
  callId: string;
  /** Throws with a useful message if the session has no tab group yet. */
  requireSession(): Promise<Session>;
  /** Creates the tab group if it is missing. */
  ensureSession(opts?: { url?: string; title?: string; newWindow?: boolean }): Promise<Session>;
  /** Nested dispatch, used by browser_batch. */
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolDefinition<Shape extends Record<string, Schema<unknown>>> {
  name: string;
  description: string;
  input: Shape;
  /** Safe to run inside browser_batch. Batch itself is not. */
  batchable?: boolean;
  /** Changes page state; gets the origin guard and the running-state colour. */
  mutating?: boolean;
  execute(
    args: { [K in keyof Shape]: Shape[K] extends Schema<infer T> ? T : never },
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

interface RegisteredTool {
  schema: ToolSchema;
  parse(args: Record<string, unknown>): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  mutating: boolean;
}

const tools = new Map<string, RegisteredTool>();

export function defineTool<Shape extends Record<string, Schema<unknown>>>(
  def: ToolDefinition<Shape>,
): void {
  if (tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
  const shape = def.input as Record<string, Schema<unknown>>;
  tools.set(def.name, {
    schema: {
      name: def.name,
      description: def.description,
      inputSchema: objectSchemaJSON(shape),
      batchable: def.batchable ?? false,
      mutating: def.mutating ?? false,
    },
    parse(args) {
      const out: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(shape)) {
        const parsed = schema.parse(args[key], key);
        if (parsed !== undefined) out[key] = parsed;
      }
      const unknownKeys = Object.keys(args).filter((k) => !(k in shape));
      if (unknownKeys.length) {
        throw new ValidationError(
          `unknown argument${unknownKeys.length > 1 ? "s" : ""}: ${unknownKeys.join(", ")}. ` +
            `Accepted: ${Object.keys(shape).join(", ") || "(none)"}`,
        );
      }
      return out;
    },
    execute: def.execute as RegisteredTool["execute"],
    mutating: def.mutating ?? false,
  });
}

export function listTools(): ToolSchema[] {
  return [...tools.values()]
    .map((t) => t.schema)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function hasTool(name: string): boolean {
  return tools.has(name);
}

export function isBatchable(name: string): boolean {
  return tools.get(name)?.schema.batchable === true;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

let callCounter = 0;

export interface ExecuteOptions {
  name: string;
  args: Record<string, unknown>;
  session?: SessionRef;
  client: string;
}

export async function executeTool(opts: ExecuteOptions): Promise<ToolResult> {
  const tool = tools.get(opts.name);
  if (!tool) {
    const near = suggest(opts.name);
    return errorResult(
      `No tool named ${opts.name}.` + (near ? ` Did you mean ${near}?` : ""),
    );
  }

  const sessionId = opts.session?.sessionId ?? `client:${opts.client}`;
  const ctx = makeContext(sessionId, opts.client);

  let args: Record<string, unknown>;
  try {
    args = tool.parse(opts.args);
  } catch (err) {
    if (err instanceof ValidationError) {
      return errorResult(`${opts.name}: ${err.message}`);
    }
    throw err;
  }

  if (tool.mutating) await setSessionState(sessionId, "running").catch(() => {});
  try {
    const result = await tool.execute(args, ctx);
    if (tool.mutating) await setSessionState(sessionId, "idle").catch(() => {});
    return result;
  } catch (err) {
    if (tool.mutating) await setSessionState(sessionId, "attention").catch(() => {});
    return errorResult(describeError(opts.name, err));
  }
}

export function makeContext(sessionId: string, client: string): ToolContext {
  const callId = `c${Date.now().toString(36)}${(callCounter++ % 4096).toString(36)}`;
  return {
    sessionId,
    client,
    callId,
    requireSession: () => requireSession(sessionId),
    ensureSession: (o = {}) => createSession({ sessionId, ...o }),
    call: (name, args) => executeTool({ name, args, session: { sessionId }, client }),
  };
}

function describeError(toolName: string, err: unknown): string {
  if (err instanceof PricklyError) return err.message;
  if (err instanceof ValidationError) return `${toolName}: ${err.message}`;
  const message = String((err as Error)?.message ?? err);
  return `${toolName} failed: ${message}`;
}

/** Cheap edit-distance-ish suggestion, so a typo does not cost a whole turn. */
function suggest(name: string): string | null {
  const names = [...tools.keys()];
  const exact = names.find((n) => n.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const contains = names.filter(
    (n) => n.includes(name) || name.includes(n.replace(/_/g, "")),
  );
  return contains[0] ?? null;
}
