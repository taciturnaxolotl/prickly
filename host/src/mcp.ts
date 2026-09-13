/**
 * MCP server over stdio.
 *
 * The tool list is not hardcoded here. It is read from whichever browser is
 * connected, then each tool gains one extra optional argument naming the
 * browser to run it against. That means the extension stays the single source
 * of truth for its own surface, and adding a tool there shows up here without
 * a second edit.
 *
 * Browsers are found through the registry, so several profiles can be driven
 * from one agent session by passing `browser: "dia"`.
 */

import { BrowserClient } from "./client";
import { describe, listBrowsers, resolveBrowser, type ListedBrowser } from "./registry";
import { HOST_VERSION } from "./version";
import { PricklyError, type ToolResult, type ToolSchema } from "../../shared/protocol";

const BROWSER_ARG = {
  type: "string",
  description:
    "Which browser profile to drive: its label or a prefix of its id. " +
    "Omit to use the only connected browser, or the one set with prickly_use_browser.",
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Browser pool
// ---------------------------------------------------------------------------

class Pool {
  private clients = new Map<string, BrowserClient>();
  private schemas = new Map<string, ToolSchema[]>();
  private defaultBrowserId: string | null = null;
  readonly sessionId: string;

  constructor(clientName: string) {
    // One session id per agent process, reused across every browser it talks
    // to, so each browser gives this agent its own tab group.
    this.sessionId =
      process.env.PRICKLY_SESSION ??
      `${slug(clientName)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  }

  browsers(): ListedBrowser[] {
    return listBrowsers();
  }

  async clientFor(name: string | undefined): Promise<{ browser: ListedBrowser; client: BrowserClient }> {
    const resolved = resolveBrowser(name, this.browsers());
    if (resolved === null) {
      const found = this.browsers();
      throw new PricklyError(
        found.length
          ? `No browser matched ${JSON.stringify(name)}. Connected: ${found.map((b) => describe(b)).join("; ")}.`
          : "No browsers are connected. Is the extension loaded and the native host installed?",
        "no_such_browser",
      );
    }
    if (Array.isArray(resolved)) {
      throw new PricklyError(
        `"${name}" matches several browsers: ${resolved.map((b) => describe(b)).join("; ")}. Be more specific.`,
        "no_such_browser",
      );
    }

    let client = this.clients.get(resolved.browserId);
    if (client?.isConnected) return { browser: resolved, client };

    client = new BrowserClient(resolved.socket, {
      onClose: () => {
        this.clients.delete(resolved.browserId);
        this.schemas.delete(resolved.browserId);
        if (this.defaultBrowserId === resolved.browserId) this.defaultBrowserId = null;
      },
    });
    await client.connect();
    await client.hello(`mcp:${this.sessionId}`);
    this.clients.set(resolved.browserId, client);
    return { browser: resolved, client };
  }

  async schemasFor(browserId: string): Promise<ToolSchema[]> {
    const cached = this.schemas.get(browserId);
    if (cached) return cached;
    const client = this.clients.get(browserId);
    if (!client) return [];
    const tools = await client.listTools();
    this.schemas.set(browserId, tools);
    return tools;
  }

  /** Union across every connected browser, deduplicated by name. */
  async allSchemas(): Promise<ToolSchema[]> {
    const merged = new Map<string, ToolSchema>();
    for (const browser of this.browsers()) {
      try {
        const { client } = await this.clientFor(browser.browserId);
        void client;
        for (const tool of await this.schemasFor(browser.browserId)) {
          if (!merged.has(tool.name)) merged.set(tool.name, tool);
        }
      } catch {
        // A browser that vanished mid-listing should not break the whole list.
      }
    }
    return [...merged.values()];
  }

  setDefault(browserId: string): void {
    this.defaultBrowserId = browserId;
  }

  get defaultId(): string | null {
    return this.defaultBrowserId;
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class McpServer {
  private pool: Pool;
  private buffer = "";
  /** In-flight requests, so a closing stdin does not cut off a reply. */
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly writeLine: (line: string) => void,
    clientName = "agent",
  ) {
    this.pool = new Pool(clientName);
  }

  /** Feed one chunk of stdin. JSON-RPC messages are newline-delimited. */
  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const work = this.handleLine(line);
      this.inFlight.add(work);
      void work.finally(() => this.inFlight.delete(work));
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // Notifications have no id and want no reply.
    if (message.id === undefined || message.id === null) {
      if (message.method === "notifications/initialized") {
        const info = message.params?.clientInfo as { name?: string } | undefined;
        this.pool = new Pool(info?.name ?? "agent");
      }
      return;
    }

    try {
      const result = await this.dispatch(message);
      this.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: err instanceof PricklyError ? -32000 : -32603,
          message: String((err as Error)?.message ?? err),
        },
      });
    }
  }

  private async dispatch(message: JsonRpcRequest): Promise<unknown> {
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "prickly", version: HOST_VERSION },
          instructions:
            "Browser control for one or more Chrome-family profiles. Call prickly_browsers first " +
            "to see what is connected. Then prickly_tabs_context with createIfEmpty: true to open " +
            "a tab group; every later call is scoped to that group. Prefer refs from read_page or " +
            "find over raw coordinates, and batch independent steps with browser_batch.",
        };

      case "ping":
        return {};

      case "tools/list":
        return { tools: await this.toolList() };

      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        return this.callTool(name, args);
      }

      default:
        throw new PricklyError(`Unknown method: ${message.method}`, "unknown_method");
    }
  }

  // -------------------------------------------------------------------------
  // Tool list
  // -------------------------------------------------------------------------

  private async toolList(): Promise<unknown[]> {
    const out: unknown[] = [
      {
        name: "prickly_browsers",
        description:
          "Lists the browser profiles currently connected, with their labels, versions, and ids. " +
          "Call this first: everything else needs a browser, and there may be more than one.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "prickly_use_browser",
        description:
          "Sets the default browser for later calls, so you do not have to repeat the browser " +
          "argument. Fails if the name is ambiguous.",
        inputSchema: {
          type: "object",
          properties: { browser: { ...BROWSER_ARG, description: "Label or id prefix of the browser to make default." } },
          required: ["browser"],
          additionalProperties: false,
        },
      },
    ];

    const schemas = await this.pool.allSchemas();
    for (const tool of schemas) {
      const properties = { ...tool.inputSchema.properties };
      if (!("browser" in properties)) properties.browser = BROWSER_ARG;
      out.push({
        name: `prickly_${tool.name}`,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties,
          required: tool.inputSchema.required ?? [],
          additionalProperties: false,
        },
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "prickly_browsers") {
      const browsers = this.pool.browsers();
      if (!browsers.length) {
        return asMcp(
          "No browsers are connected.\n\n" +
            "Checklist:\n" +
            "1. Load extension/dist as an unpacked extension in each browser you want to drive.\n" +
            "2. Run `bun run scripts/install-host.ts` so Chrome can find the native host.\n" +
            "3. Reload the extension; its toolbar icon should show no warning badge.",
          true,
        );
      }
      const lines = browsers.map((b) => {
        const marker = b.browserId === this.pool.defaultId ? "*" : " ";
        return `${marker} ${b.profile.padEnd(16)} ${b.browser} ${b.browserVersion}  id=${b.browserId.slice(0, 8)}  socket=${b.socket}`;
      });
      return asMcp(
        [
          `${browsers.length} browser profile(s) connected (* = default):`,
          ...lines,
          "",
          `Pass browser: "<label or id prefix>" to any tool to target one specifically.`,
        ].join("\n"),
      );
    }

    if (name === "prickly_use_browser") {
      const wanted = String(args.browser ?? "");
      const { browser } = await this.pool.clientFor(wanted);
      this.pool.setDefault(browser.browserId);
      return asMcp(`Default browser is now ${describe(browser)}. Session ${this.pool.sessionId}.`);
    }

    if (!name.startsWith("prickly_")) {
      return asMcp(`No tool named ${name}.`, true);
    }
    const toolName = name.slice("prickly_".length);

    const { browser, client } = await this.pool.clientFor(
      args.browser !== undefined ? String(args.browser) : this.pool.defaultId ?? undefined,
    );
    const forwarded = { ...args };
    delete forwarded.browser;

    let result: ToolResult;
    try {
      result = await client.callTool(toolName, forwarded, this.pool.sessionId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return asMcp(`${browser.profile}: ${detail}`, true);
    }
    return {
      content: result.content,
      isError: result.isError ?? false,
      ...(result.meta ? { _meta: { prickly: result.meta, browser: browser.profile } } : {}),
    };
  }

  private send(payload: unknown): void {
    this.writeLine(`${JSON.stringify(payload)}\n`);
  }

  /** Waits for outstanding replies before the caller exits. */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((r) => setTimeout(r, 250)),
      ]);
    }
  }

  close(): void {
    this.pool.close();
  }
}

function asMcp(text: string, isError = false): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}
