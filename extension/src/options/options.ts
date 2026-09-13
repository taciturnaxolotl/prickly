/**
 * Options page. Plain DOM, no framework: it is four fields.
 */

interface DenyRule {
  host: string;
  path?: string;
  note?: string;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

async function loadIdentity(): Promise<void> {
  const list = $("identity") as unknown as HTMLDListElement;
  const status = (await chrome.runtime.sendMessage({ type: "PRICKLY_STATUS" }).catch(() => null)) as {
    connected?: boolean;
    host?: string;
    client?: string;
  } | null;

  const { browserId, profileLabel } = await chrome.storage.local.get(["browserId", "profileLabel"]);
  const ua = navigator.userAgent;

  const rows: [string, string][] = [
    ["extension id", chrome.runtime.id],
    ["browser id", (browserId as string | undefined) ?? "(not generated yet)"],
    ["profile", (profileLabel as string | undefined) ?? "(default)"],
    ["user agent", ua.slice(0, 80)],
    ["native host", status?.host ?? "(not connected)"],
    [
      "connection",
      status?.connected ? `connected, last client ${status.client ?? "?"}` : "disconnected",
    ],
  ];

  list.replaceChildren(
    ...rows.flatMap(([key, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

function parseDenylist(raw: string): DenyRule[] {
  const rules: DenyRule[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hostPart, ...rest] = trimmed.split(/\s+/);
    const note = rest.join(" ").replace(/^#\s*/, "") || undefined;
    if (!hostPart) continue;

    const slash = hostPart.indexOf("/");
    if (slash === -1) {
      rules.push({ host: hostPart, note });
    } else {
      rules.push({ host: hostPart.slice(0, slash), path: hostPart.slice(slash), note });
    }
  }
  return rules;
}

function formatDenylist(rules: DenyRule[]): string {
  return rules
    .map((r) => `${r.host}${r.path ?? ""}${r.note ? ` # ${r.note}` : ""}`)
    .join("\n");
}

function flash(id: string): void {
  const el = $(id);
  el.classList.add("on");
  setTimeout(() => el.classList.remove("on"), 1200);
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(["denylist", "profileLabel", "stripInterference"]);
  ($("label") as HTMLInputElement).value = (stored.profileLabel as string | undefined) ?? "";
  ($("deny") as HTMLTextAreaElement).value = formatDenylist(
    (stored.denylist as DenyRule[] | undefined) ?? [],
  );
  ($("strip") as HTMLInputElement).checked = stored.stripInterference !== false;
}

$("save-label").addEventListener("click", async () => {
  const value = ($("label") as HTMLInputElement).value.trim();
  if (value) await chrome.storage.local.set({ profileLabel: value });
  else await chrome.storage.local.remove("profileLabel");
  flash("label-saved");
  await loadIdentity();
});

$("save-deny").addEventListener("click", async () => {
  const rules = parseDenylist(($("deny") as HTMLTextAreaElement).value);
  await chrome.storage.local.set({ denylist: rules });
  ($("deny") as HTMLTextAreaElement).value = formatDenylist(rules);
  flash("deny-saved");
});

$("strip").addEventListener("change", async (event) => {
  const checked = (event.target as HTMLInputElement).checked;
  await chrome.storage.local.set({ stripInterference: checked });
});

// Bundled as an IIFE, which has no top-level await, so boot it explicitly.
void (async () => {
  await loadIdentity();
  await load();
})();
