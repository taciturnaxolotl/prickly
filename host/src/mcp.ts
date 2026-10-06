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

import { watch, type FSWatcher } from "node:fs";
import { BrowserClient } from "./client";
import {
  describe,
  ensureRegistryDir,
  listBrowsers,
  resolveBrowser,
  type ListedBrowser,
} from "./registry";
import { HOST_VERSION } from "./version";
import { PricklyError, type ToolResult, type ToolSchema } from "../../shared/protocol";

const BROWSER_ARG = {
  type: "string",
  description:
    "Which browser profile to drive: its label or a prefix of its id. " +
    "Omit to use the only connected browser, or the one set with prickly_use_browser.",
};

// Several profiles of one browser process each register a host, but only one
// profile's extension answers at a time. The rest accept the socket and then
// stay silent, so the handshake needs a short leash of its own.
const HANDSHAKE_TIMEOUT_MS = 3_000;

// Registry changes arrive in bursts (a descriptor and its socket land
// together), so wait for the dust to settle before asking browsers again.
const REGISTRY_SETTLE_MS = 500;

// While no browser has answered, keep asking. A profile can wake up without
// touching the registry, for instance when the person switches to it.
const RETRY_WHILE_EMPTY_MS = 15_000;

const BUILTIN_TOOLS = ["prickly_browsers", "prickly_use_browser"];

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

  constructor(
    clientName: string,
    private readonly onChange: () => void = () => {},
  ) {
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
        const hadSchemas = this.schemas.delete(resolved.browserId);
        if (this.defaultBrowserId === resolved.browserId) this.defaultBrowserId = null;
        if (hadSchemas) this.onChange();
      },
    });
    await client.connect();
    try {
      await client.hello(`mcp:${this.sessionId}`, HANDSHAKE_TIMEOUT_MS);
    } catch (err) {
      client.close();
      throw new PricklyError(
        `${describe(resolved)} is not responding. If it shares a browser with another ` +
          `connected profile, only one of them is active at a time; switch to it or pick another.`,
        "timeout",
        { cause: String(err) },
      );
    }
    this.clients.set(resolved.browserId, client);
    return { browser: resolved, client };
  }

  async schemasFor(browserId: string): Promise<ToolSchema[]> {
    const cached = this.schemas.get(browserId);
    if (cached) return cached;
    const client = this.clients.get(browserId);
    if (!client) return [];
    const tools = await client.listTools(HANDSHAKE_TIMEOUT_MS);
    this.schemas.set(browserId, tools);
    this.onChange();
    return tools;
  }

  /** Names of every tool known right now, without asking any browser. */
  knownToolNames(): string[] {
    const names = new Set(BUILTIN_TOOLS);
    for (const tools of this.schemas.values()) {
      for (const tool of tools) names.add(`prickly_${tool.name}`);
    }
    return [...names].sort();
  }

  get hasBrowserTools(): boolean {
    return [...this.schemas.values()].some((tools) => tools.length > 0);
  }

  /** Union across every connected browser, deduplicated by name. */
  async allSchemas(): Promise<ToolSchema[]> {
    // In parallel, so one silent profile costs a single handshake timeout
    // rather than stalling the list behind it.
    const lists = await Promise.all(
      this.browsers().map(async (browser) => {
        try {
          await this.clientFor(browser.browserId);
          return await this.schemasFor(browser.browserId);
        } catch {
          // A browser that vanished or went quiet should not break the whole list.
          return [];
        }
      }),
    );
    const merged = new Map<string, ToolSchema>();
    for (const tool of lists.flat()) {
      if (!merged.has(tool.name)) merged.set(tool.name, tool);
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

  /**
   * The tool list as the client last saw it, so a change can be announced
   * exactly once. Null until the client has asked, since there is nothing to
   * be stale against before then.
   */
  private advertised: string | null = null;
  private initialized = false;
  private watcher: FSWatcher | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  /** A tools/list in progress will report the latest state itself. */
  private listing = 0;

  constructor(
    private readonly writeLine: (line: string) => void,
    clientName = "agent",
  ) {
    this.pool = this.newPool(clientName);
  }

  private newPool(clientName: string): Pool {
    return new Pool(clientName, () => this.announceIfChanged());
  }

  /**
   * Tells the client to fetch the tool list again when it no longer matches
   * what the client was last given. Browsers come and go long after an agent
   * starts, and without this the agent keeps whatever it saw at startup.
   */
  private announceIfChanged(): void {
    if (!this.initialized || this.advertised === null || this.listing > 0) return;
    const current = this.pool.knownToolNames().join(",");
    if (current === this.advertised) return;
    this.advertised = current;
    this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  /** Asks every registered browser for its tools, one refresh at a time. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.pool
      .allSchemas()
      .then(() => this.announceIfChanged())
      .catch(() => {})
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private scheduleRefresh(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.refresh();
    }, REGISTRY_SETTLE_MS);
    this.settleTimer.unref?.();
  }

  private startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(ensureRegistryDir(), () => this.scheduleRefresh());
      this.watcher.unref?.();
    } catch {
      // Without a watcher the retry timer below still covers the empty case.
    }
    this.retryTimer = setInterval(() => {
      if (!this.pool.hasBrowserTools) void this.refresh();
    }, RETRY_WHILE_EMPTY_MS);
    this.retryTimer.unref?.();
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.settleTimer = null;
    this.retryTimer = null;
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
        this.pool.close();
        this.pool = this.newPool(info?.name ?? "agent");
        this.initialized = true;
        this.startWatching();
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
          capabilities: { tools: { listChanged: true } },
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
        this.listing++;
        try {
          return { tools: await this.toolList() };
        } finally {
          this.listing--;
        }

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
    this.advertised = (out as { name: string }[])
      .map((tool) => tool.name)
      .sort()
      .join(",");
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
    this.stopWatching();
    this.pool.close();
  }
}

function asMcp(text: string, isError = false): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}
