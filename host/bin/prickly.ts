#!/usr/bin/env bun
/**
 * prickly CLI.
 *
 *   native-host   run as Chrome's native messaging host (the manifest points here)
 *   mcp           run as an MCP server over stdio, for agents
 *   browsers      list connected browser profiles
 *   probe         poke a connected browser directly; no agent required
 */

import { McpServer } from "../src/mcp";
import { describe, listBrowsers, resolveBrowser } from "../src/registry";
import { BrowserClient } from "../src/client";

const command = process.argv[2] ?? "help";

switch (command) {
  case "native-host":
    await import("../src/native");
    break;

  case "mcp":
    runMcp();
    break;

  case "browsers": {
    const browsers = listBrowsers();
    if (!browsers.length) {
      console.log("no browsers connected");
      console.log("");
      console.log("Load extension/dist as an unpacked extension, then run:");
      console.log("  bun run scripts/install-host.ts");
      process.exit(1);
    }
    for (const browser of browsers) {
      console.log(`${describe(browser)}`);
      console.log(`  id      ${browser.browserId}`);
      console.log(`  socket  ${browser.socket}`);
      console.log(`  host    ${browser.pid} (protocol ${browser.protocolVersion}, host ${browser.hostVersion})`);
    }
    break;
  }

  case "probe":
    await runProbe();
    break;

  case "reload":
    await runReload();
    break;

  default:
    console.log(`prickly ${command === "help" ? "" : `: unknown command "${command}"`}`.trim());
    console.log("");
    console.log("usage: prickly <command>");
    console.log("");
    console.log("  native-host          run as Chrome's native messaging host");
    console.log("  mcp                  run as an MCP server over stdio");
    console.log("  browsers             list connected browser profiles");
    console.log("  reload [--no-build]  rebuild and reload the extension in place");
  console.log("  probe [browser]      drive a browser from the shell:");
    console.log("                         probe dia 'tabs_context {\"createIfEmpty\":true}'");
    console.log("                         probe dia 'computer {\"action\":\"screenshot\"}'");
    process.exit(command === "help" ? 0 : 1);
}

// ---------------------------------------------------------------------------

function runMcp(): void {
  const server = new McpServer((line) => {
    process.stdout.write(line);
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => server.feed(chunk));
  process.stdin.on("end", () => {
    // stdin closing does not mean the work is done; a tool call already on its
    // way to the browser still deserves its reply.
    void server.drain().then(() => {
      server.close();
      process.exit(0);
    });
  });
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

async function runProbe(): Promise<void> {
  const args = process.argv.slice(3);
  const browsers = listBrowsers();
  if (!browsers.length) {
    console.error("no browsers connected");
    process.exit(1);
  }

  let target = args[0];
  let call = args[1];

  // `probe 'tabs_context {}'` with one browser needs no name.
  if (target && !call && target.includes("{")) {
    call = target;
    target = undefined;
  }
  if (!call) {
    const resolved = resolveBrowser(target);
    if (!resolved || Array.isArray(resolved)) {
      console.error(`usage: prickly probe [browser] '<tool> <json args>'`);
      console.error(`connected: ${browsers.map((b) => b.profile).join(", ")}`);
      process.exit(1);
    }
    const client = new BrowserClient(resolved.socket);
    await client.connect();
    await client.hello("probe");
    const tools = await client.listTools();
    console.log(`${describe(resolved)}: ${tools.length} tools`);
    for (const tool of tools) console.log(`  ${tool.name}${tool.batchable ? " (batchable)" : ""}`);
    client.close();
    return;
  }

  const space = call.indexOf(" ");
  const tool = space === -1 ? call : call.slice(0, space);
  const rawArgs = space === -1 ? "{}" : call.slice(space + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch (err) {
    console.error(`bad JSON arguments: ${String(err)}`);
    process.exit(1);
  }

  const browser = resolveBrowser(target);
  if (!browser || Array.isArray(browser)) {
    console.error(`no browser matched ${JSON.stringify(target)}`);
    process.exit(1);
  }

  const client = new BrowserClient(browser.socket);
  await client.connect();
  await client.hello("probe");
  const result = await client.callTool(tool, parsed, `probe-${process.pid}`);

  for (const block of result.content) {
    if (block.type === "text") {
      console.log(block.text);
    } else {
      const out = `/tmp/prickly-probe-${Date.now()}.jpg`;
      await Bun.write(out, Buffer.from(block.data, "base64"));
      console.log(`[image ${block.mimeType} -> ${out}]`);
    }
  }
  if (result.meta) console.error(`meta: ${JSON.stringify(result.meta)}`);
  client.close();
  process.exit(result.isError ? 1 : 0);
}

/**
 * Rebuild and reload the extension without touching the browser UI.
 *
 * The extension reloads itself, which kills this host process, so the socket
 * drops mid-call. That is success, not failure: wait for a new descriptor to
 * appear and report the fresh pid.
 */
async function runReload(): Promise<void> {
  const skipBuild = process.argv.includes("--no-build");
  if (!skipBuild) {
    const root = new URL("../..", import.meta.url).pathname;
    const build = Bun.spawnSync([process.execPath, "run", `${root}extension/build.ts`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(build.stdout).trim();
    if (build.exitCode !== 0) {
      console.error(new TextDecoder().decode(build.stderr).trim() || out);
      process.exit(1);
    }
    console.log(out || "built");
  }

  const before = listBrowsers();
  if (!before.length) {
    console.error("no browsers connected");
    process.exit(1);
  }

  for (const target of before) {
    const client = new BrowserClient(target.socket);
    try {
      await client.connect();
      // The reply may never arrive; the extension tears itself down to reload.
      await client.request("reload", {}, 3000).catch(() => {});
    } catch {
      // Already gone, which is the state we wanted anyway.
    }
    client.close();

    const deadline = Date.now() + 20_000;
    let relaunched = false;
    while (Date.now() < deadline) {
      await Bun.sleep(250);
      const now = listBrowsers().find((b) => b.browserId === target.browserId);
      if (now && now.pid !== target.pid) {
        console.log(`${describe(now)} reloaded (host ${target.pid} -> ${now.pid})`);
        relaunched = true;
        break;
      }
    }
    if (!relaunched) {
      console.error(
        `${target.profile} did not come back within 20s. ` +
          `Reload it from the extensions page.`,
      );
      process.exit(1);
    }
  }
}
