/**
 * Builds the extension into dist/.
 *
 * Three bundles: the service worker and the page agent as ES modules, the
 * options page as a classic script. Manifest and static files are copied
 * alongside. Nothing else; no framework, no config file.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname);
const OUT = join(ROOT, "dist");
const watch = process.argv.includes("--watch");

async function build(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const result = await Bun.build({
    entrypoints: [
      join(ROOT, "src/service-worker.ts"),
      join(ROOT, "src/content/page-agent.ts"),
    ],
    outdir: OUT,
    target: "browser",
    format: "esm",
    sourcemap: "none",
    minify: false,
    naming: "[dir]/[name].js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("extension build failed");
  }

  const options = await Bun.build({
    entrypoints: [join(ROOT, "src/options/options.ts")],
    outdir: OUT,
    target: "browser",
    format: "iife",
    sourcemap: "none",
    minify: false,
    naming: "[name].js",
  });
  if (!options.success) {
    for (const log of options.logs) console.error(log);
    throw new Error("options build failed");
  }

  // page-agent.ts lands in content/ because of its path; the manifest wants it
  // at the top level so the content script entry is a plain filename.
  const nested = join(OUT, "content/page-agent.js");
  if (existsSync(nested)) {
    cpSync(nested, join(OUT, "page-agent.js"));
    rmSync(join(OUT, "content"), { recursive: true, force: true });
  }

  for (const file of ["offscreen.html", "offscreen.js", "options.html"]) {
    cpSync(join(ROOT, "public", file), join(OUT, file));
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  manifest.version = process.env.PRICKLY_VERSION ?? manifest.version;
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`built extension -> ${OUT} (${manifest.version})`);
}

await build();

if (watch) {
  // node:fs.watch works under Bun and gives us recursive watching for free on
  // macOS and Windows.
  const { watch: fsWatch } = await import("node:fs");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      build()
        .then(() => console.log("rebuilt"))
        .catch((err) => console.error(String(err)));
    }, 250);
  };
  for (const dir of ["src", "public"]) fsWatch(join(ROOT, dir), { recursive: true }, schedule);
  fsWatch(join(ROOT, "manifest.json"), schedule);
  console.log("watching src/, public/, manifest.json");
}
