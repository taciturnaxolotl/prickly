# Claude in Chrome: what it actually is

Notes from the agent side plus a teardown of extension `fcoeoabgfenejglbffodgkkbkcdhcgfn` v1.0.85
(`git-hash.txt`: `5715ccdf21171a4f05bd164ff384f78deade3568`, built with Vite, no source maps shipped).

The short version: the agent-facing surface is 22 tools, the wire protocol is two message
types, and everything that does real work is Chrome DevTools Protocol plus one 7 KB content
script. The other 19 MB of the extension is a chat client.

## 1. Architecture

Three transports reach the same dispatcher inside the extension's service worker.

```
                            ┌──────────────────────────────────────┐
 claude CLI session ──┐     │  Chrome extension (service worker)   │
 (per-pid unix sock)  │     │                                      │
                      ▼     │   executeTool(dispatcher)            │
  /tmp/claude-mcp-browser-  │     ├─ tab group resolution          │
  bridge-$USER/<pid>.sock   │     ├─ blocklist category check      │
          │                 │     ├─ permission check              │
          ▼ len-prefix JSON │     ├─ chrome.debugger attach        │
  `claude --chrome-native-  │     └─ tool.execute(args, ctx)       │
   host` (spawned by Chrome)│                                      │
          │                 │                                      │
          ├── stdio native messaging ──────────────────────────────┤
          │                 │                                      │
 claude.ai / Desktop ──── wss://bridge.claudeusercontent.com ──────┤
                            └──────────────────────────────────────┘
```

### Transport A: native messaging (what Claude Code uses)

Host manifest at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`:

```json
{
  "name": "com.anthropic.claude_code_browser_extension",
  "path": "/Users/kierank/.claude/chrome/chrome-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"]
}
```

`chrome-native-host` is a three-line shell wrapper: `exec claude --chrome-native-host`.
Chrome spawns **one** of these. It in turn listens on a unix socket at
`/tmp/claude-mcp-browser-bridge-$USER/<its-pid>.sock`, and every `claude` session connects
there. So the fan-out from N agent sessions to one extension happens in the CLI, not in Chrome.
(Unrelated: `/tmp/cc-socks/<pid>.sock` is Claude Code's own per-session IPC, not this.)

The extension probes both host names at startup and keeps whichever answers a `ping` with a
`pong` within 10s:

| name | label |
|---|---|
| `com.anthropic.claude_browser_extension` | Desktop app |
| `com.anthropic.claude_code_browser_extension` | Claude Code |

### Transport B: the cloud bridge

`wss://bridge.claudeusercontent.com/chrome/<account_uuid>`, OAuth-token authenticated. Used by
claude.ai and the Desktop app. There is a dev escape hatch: with config flag `localBridge` set,
it connects to `ws://localhost:8765` with `dev_user_id: "dev_user_local"` and no token. That is
the cheapest place to hang your own server if you want to impersonate the cloud side rather than
the native host side.

Bridge messages, extension → server: `connect`, `ping`, `pong`, `tool_result`,
`permission_request`, `pairing_response`, `notification`, `external_message_result`.
Server → extension: `paired`, `waiting`, `ping`, `pong`, `peer_connected`, `peer_disconnected`,
`tool_call`, `permission_response`, `pairing_request`, `external_message`, `external_config`,
`error`.

Keepalive is a `ping` every 20s plus a `chrome.alarms` tick every 30s; the socket is closed and
rebuilt if no `pong` lands within 90s. Reconnect is exponential (2s × 1.5ⁿ, jittered ±20%,
capped at 5 min). Close code 1008 twice in a row clears the cached access token.

### Transport C: sidepanel iframe

`CIC_IFRAME_BRIDGE_INIT` / `CIC_IFRAME_TOOL_CALL` via `chrome.runtime.sendMessage`, for the
claude.ai UI running inside the extension's own side panel. Ignore this one.

## 2. Wire protocol (the part worth cloning)

Both the native-messaging channel and the unix socket speak the same thing. Framing on the
socket is Chrome-native-messaging style: **4-byte little-endian length prefix, then UTF-8 JSON**.
It is *not* MCP JSON-RPC — the MCP server lives in the CLI and this is what sits behind it.

Verified live against a running host:

```
→ {"method":"get_bridge_identity","params":{"echo":"probe123"}}
← {"result":{"bridge_device_id":"59e4a5e5-…","echo":"probe123"}}

→ {"method":"execute_tool","params":{"tool":"tabs_context_mcp","args":{},"client_id":"probe"}}
← {"result":{"content":[{"type":"text","text":"No MCP tab groups found. Use createIfEmpty: true to create one."}]}}

→ {"method":"tools/list"}
← {"result":{"content":"Unknown method: tools/list"}}
```

Exactly two methods exist. Over stdio the frames are wrapped as
`{type:"tool_request", method, params}` and answered as `{type:"tool_response", result|error}`.

`execute_tool` params:

| field | meaning |
|---|---|
| `tool` | tool name |
| `args` | tool input object |
| `client_id` | free-form client label, telemetry only |
| `session_scope` | `{sessionId, tabGroupId}`, scopes the agent to its own tab group |

Results are MCP content blocks: `{content: [{type:"text"|"image", …}]}`, or
`{error:{content:[…]}}`. Note there is **no request id** on this channel — it is strictly
serialized, one in-flight call at a time. The cloud bridge adds `tool_use_id` and
`target_device_id` for multiplexing; the local one does not. If you want concurrency in your own
version, add an id. It is the single clearest weakness in the design.

Other lifecycle messages on the stdio channel: host → extension `pong`, `status_response`,
`mcp_connected`, `mcp_disconnected`; extension → host `ping`, `get_status`.

## 3. The tool surface

22 tools. The names and schemas the agent sees are below; where the extension's internal schema
differs, that is flagged.

### Tabs and session

| tool | input | notes |
|---|---|---|
| `tabs_context_mcp` | `{createIfEmpty?}` | Must be called once before anything else. Returns the tab ids in this session's Chrome tab *group*. `createIfEmpty` spawns a new window + group. |
| `tabs_create_mcp` | `{}` | New tab inside the group. |
| `tabs_close_mcp` | `{tabId}` | Group members only. Closing the last one removes the group. |
| `resize_window` | `{width, height, tabId}` | |

Everything is scoped to a Chrome tab group per session. Tools refuse tab ids outside the group.
This is the isolation primitive and it is worth copying: it is what keeps an agent out of your
banking tab without needing any policy.

### Navigation and input

| tool | input | notes |
|---|---|---|
| `navigate` | `{url, tabId?}` | `url` may be `"back"` / `"forward"` (tabId required then). Standalone calls auto-resolve a tab. |
| `computer` | `{action, tabId, …}` | The big one, below. |
| `form_input` | `{ref, value, tabId}` | Sets a value directly, bypassing keystroke simulation. |
| `file_upload` | agent: `{paths[], ref, tabId}` | **The MCP server rewrites this.** The extension only accepts `{files:[{data:base64, name, mimeType}]}`; host paths are explicitly rejected with a "update the desktop app" error. The CLI reads the file and base64s it. |
| `upload_image` | `{imageId, ref\|coordinate, tabId, filename?}` | Replays a screenshot the agent captured earlier into a file input or drop target. |

`computer` actions: `screenshot`, `zoom`, `left_click`, `right_click`, `double_click`,
`triple_click`, `hover`, `left_click_drag`, `type`, `key`, `scroll`, `scroll_to`, `wait`.
Clicks take either `coordinate: [x,y]` or `ref` from `read_page`/`find`. `modifiers` accepts
`ctrl|shift|alt|cmd|meta|win` joined with `+`. `key` takes space-separated keys and a `repeat`
count up to 100. `wait` caps at 10s. Page-zoom shortcuts (`cmd+=`) are explicitly rejected;
`zoom` with a `region` is the substitute.

### Reading

| tool | input | notes |
|---|---|---|
| `read_page` | `{tabId, filter?, depth?, ref_id?, max_chars?}` | Accessibility tree. `filter:"interactive"` for controls only. Default depth 15, default budget 50 000 chars, truncated at a line boundary with a note giving the true size. |
| `find` | `{query, tabId}` | Natural-language element lookup. Caps at 20 matches. |
| `get_page_text` | `{tabId}` | Article-ish plain text. |
| `read_console_messages` | `{tabId, pattern?, onlyErrors?, limit?, clear?}` | Current domain only. |
| `read_network_requests` | `{tabId, urlPattern?, limit?, clear?}` | Cleared on cross-domain navigation. |

### Scripting and extras

| tool | input | notes |
|---|---|---|
| `javascript_tool` | `{action:"javascript_exec", text, tabId}` | REPL semantics via CDP `Runtime.evaluate` with `replMode:true`; top-level await works, last expression is the result. Falls back to wrapping in an async IIFE if it sees "Illegal return statement". Returned values are walked to depth 5 and any key matching `/password\|token\|secret\|api[_-]?key\|auth\|creden…/i` is redacted. |
| `browser_batch` | `{actions:[{name, input}]}` | Sequential, stops on first error, cannot nest. Coordinates refer to the screenshot taken *before* the batch. |
| `gif_creator` | `{action, tabId, filename?, options?}` | `start_recording` / `stop_recording` / `export` / `clear`. Overlays click circles, drag arrows, labels, progress bar, watermark. |
| `shortcuts_list` / `shortcuts_execute` | `{tabId, …}` | Runs user-defined extension "workflows" in a side panel. Fire and forget. |
| `list_connected_browsers` / `select_browser` / `switch_browser` | | Multi-device pairing over the cloud bridge only. |

The extension nudges toward batching: a single-tool turn where the tool was batchable gets a
`<system-reminder>` appended to the result telling the agent to use `browser_batch` next time.
I saw it fire on my probe call. Cute, and effective.

## 4. How the tools are actually implemented

The dispatcher attaches `chrome.debugger` (protocol 1.3) to the target tab before nearly every
call, then:

| capability | mechanism |
|---|---|
| screenshots | CDP `Page.captureScreenshot`, `fromSurface:true`, `captureBeyondViewport:false`, optional `clip`. JPEG starting at quality 0.75, stepping down by 0.05 to a floor of 0.1 until base64 fits `MAX_BASE64_CHARS = 1398100` (~1 MB). Decoded dimensions are verified against the expected clip. |
| mouse | CDP `Input.dispatchMouseEvent` — a `mouseMoved` first, then press/release, with `clickCount` for multi-clicks and `deltaX/deltaY` for `mouseWheel`. |
| keyboard | CDP `Input.dispatchKeyEvent` and `Input.insertText`. |
| JS eval | CDP `Runtime.evaluate`, 45s ceiling. |
| console | CDP `Runtime.enable` + `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`. |
| network | CDP `Network.enable` (`maxPostDataSize: 65536`) + `requestWillBeSent` / `responseReceived` / `loadingFailed`. |
| dialogs | `Page.javascriptDialogOpening` is intercepted and auto-answered with `Page.handleJavaScriptDialog`, with a `beforeunload` policy per tab. Nice touch — it means alerts do not wedge the session the way the docs warn. |
| a11y tree, refs, form input, file upload | `chrome.scripting.executeScript`, not CDP. |

Two quirks worth knowing before you reimplement:

- **Debugger attach is fragile and they fight for it.** If DevTools is open on a tab, attach
  fails outright. There is a whole `stripExtensionInterference` routine that walks every frame
  including open *and closed* shadow roots via `chrome.dom.openOrClosedShadowRoot`, deletes
  foreign `chrome-extension://` iframes, and retries attach up to 4 times. Other extensions
  injecting iframes genuinely break CDP attach.
- **`chrome://` and `chrome-extension://` pages cannot be driven at all.** Hard error.

### The element-ref system

`assets/accessibility-tree.js` is a 7 KB content script injected at `document_start` into all
frames of all URLs. It is the entire `read_page` / `find` / `ref` engine:

```js
window.__claudeElementMap        // "ref_N" -> WeakRef(element)
window.__claudeElementReverseMap // WeakMap(element -> "ref_N")
window.__claudeRefCounter
window.__generateAccessibilityTree(rootRef, maxDepth, …)
```

Roles come from an explicit `role` attribute, else a hardcoded tag→role table
(`a`→link, `input[type=checkbox]`→checkbox, `h1-h6`→heading, and so on). Accessible names try
`aria-label`, `placeholder`, `title`, `alt`, then `label[for=…]`. Refs are `WeakRef`s, so stale
refs report "garbage collected" or "no longer in the document" rather than silently acting on
the wrong node. Sensitive inputs (`type=password`, `type=hidden`, or `autocomplete` matching
`current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp*`) get their
values reported as `[value redacted]`.

This file is small, self-contained, and the single most directly reusable piece in the whole
extension.

## 5. Safety machinery

Two independent layers, both worth understanding even if you drop them.

### Domain classification (server-side)

Every URL is POSTed to `https://api.anthropic.com/api/web/url_hash_check/browser_extension` with
a bearer token. Results cached 5 minutes.

| category | effect |
|---|---|
| `category0` | fine |
| `category1`, `category2` | hard blocked, tool returns "This site is blocked." |
| `category3` | allowed but forces a permission prompt regardless of stored grants |
| `category4` | allowed, but injects a one-time copyright acknowledgement into the result |
| `category_org_blocked` | matched an admin `blockedUrlPatterns` policy in `chrome.storage.managed` |
| `category_unknown_error` | **fails closed** — blocked as a precaution |

A whole-tab-group most-restrictive-category is tracked, so opening a blocked page in a secondary
tab poisons the group. This layer is a network dependency on Anthropic infra; for your own build
it is the first thing to cut, and a local pattern list is the obvious replacement.

### Permission grants (local)

Stored in `chrome.storage.local`. A grant is `{id, scope, action, duration, surface, createdAt}`
where scope is either `{type:"netloc", netloc}` (supports `*.example.com`) or
`{type:"domain_transition", fromDomain, toDomain}`; duration is `ONCE` / session / `ALWAYS`;
action is `ALLOW` / `DENY`. Deny wins over allow. `ONCE` grants are bound to a specific
`toolUseId` and origin and are consumed on use.

Layered on top, per call: `permissionMode: "skip_all_permission_checks"`, a turn-scoped
`allowedDomains` set, a `deniedDomains` set, and a `forcePrompt` flag. Localhost can be
auto-bypassed via `bypassLocalhostForMcp`. Domain transitions get their own prompt, so a click
that navigates off-site re-asks.

When `handle_permission_prompts` is set, the extension does not prompt in Chrome; it sends a
`permission_request` back over the bridge and waits for a `permission_response`. That is how the
CLI shows the approval in the terminal instead of the browser. If you build your own controller,
this is the hook you want.

Denials come back with a hardcoded rider appended: *"The user has explicitly declined this
action. Do not attempt to use other tools or workarounds."*

## 6. What the 19 MB actually is

The extension is 19 MB on disk. The browser-control logic is perhaps 3% of it.

| what | size | needed? |
|---|---|---|
| `sidepanel-*.js` | 1.6 MB | no — the chat UI |
| `mcpPermissions-*.js` | 844 KB | yes, but it is a grab bag: tools + permissions + bridge + CDP wrapper all in one chunk |
| `SchedulingFields-*.js` | 828 KB | no |
| ~120 Shiki syntax-highlighter grammars (`emacs-lisp` 764 KB, `cpp` 616 KB, `wolfram` 260 KB, …) | several MB | no |
| KaTeX + fonts, Mermaid + cytoscape + dagre | ~1 MB | no |
| Datadog RTUM, Sentry, Segment, Honeycomb, Clarity | ~300 KB | no |
| `service-worker.ts-*.js` | 25 KB | yes — transports and dispatch entry |
| `accessibility-tree.js` | 6.8 KB | yes |
| `agent-visual-indicator.js` | 18 KB | optional, it is the on-page "agent is working" chrome |
| `gif.js` + worker | ~100 KB | optional |

Manifest permissions, for reference on what a minimal clone genuinely needs:
`debugger`, `tabs`, `tabGroups`, `scripting`, `storage`, plus `<all_urls>` host access.
Everything else in the list (`sidePanel`, `alarms`, `notifications`, `offscreen`, `downloads`,
`identity`, `unlimitedStorage`, `declarativeNetRequestWithHostAccess`, `webNavigation`) serves
the chat client, telemetry, or the iframe-stripping workaround. `nativeMessaging` is requested
*optionally* at runtime via `chrome.permissions.contains` rather than up front.

## 7. Notes for a reimplementation

What to keep:

- **Tab groups as the isolation unit.** One group per agent session, refuse ids outside it.
  Cheap to implement, and it is the whole security story that matters day to day.
- **The element-ref layer.** Coordinates alone are brittle; `WeakRef`-backed refs that can say
  "this element is gone" turn a class of silent misclicks into errors.
- **Length-prefixed JSON over a unix socket.** Trivially portable to any agent runtime, and it
  is already what the host speaks, so you can point a non-Claude agent at the existing
  `claude --chrome-native-host` process today and drive the real extension.
- **The dialog interception.** `Page.javascriptDialogOpening` + `handleJavaScriptDialog` costs
  ten lines and removes the worst failure mode in browser automation.

What to change:

- **Add a request id.** The local channel is serialized with no correlation id. One in-flight
  call per browser is a real ceiling, and it is invisible until two sessions race.
- **Drop the URL classification call.** It is a network round trip on the hot path of every
  single tool call, it fails closed, and it hands Anthropic the URL of everything you browse.
  A local deny-list gets most of the value.
- **Split the bundle.** `mcpPermissions-192xiXNg.js` holding tools, permission storage, the
  WebSocket bridge, and the CDP wrapper together is why this thing is hard to read. The seams
  are already there in the source; only the bundler hid them.

## Appendix: reproducing the probe

```js
const net = require("net");
const s = net.connect("/tmp/claude-mcp-browser-bridge-$USER/<pid>.sock");
const send = o => {
  const b = Buffer.from(JSON.stringify(o));
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  s.write(Buffer.concat([h, b]));
};
s.on("connect", () => send({ method: "execute_tool",
  params: { tool: "tabs_context_mcp", args: { createIfEmpty: true }, client_id: "probe" } }));
s.on("data", d => console.log(d.toString()));
```

Find the pid with `ls /tmp/claude-mcp-browser-bridge-$USER/`, or
`ps aux | grep chrome-native-host`. Responses come back with the same 4-byte prefix.

## 8. Clever bits worth stealing

A second pass, hunting specifically for technique rather than architecture.

### Screenshots are sized to a *token* budget, not a pixel budget

`Sw(width, height, {pxPerToken, maxTargetPx, maxTargetTokens})` binary-searches for the largest
dimensions that satisfy **both** a max pixel edge and a max estimated token count, preserving
aspect ratio (it recurses with the axes swapped for portrait images). Only if the result still
exceeds `MAX_BASE64_CHARS` does it start stepping JPEG quality down from 0.75 to a floor of 0.1.

So the resize is a deliberate "how much of the context window is this screenshot worth"
decision, and compression is the fallback rather than the first move. Most automation harnesses
do this backwards.

The matching half is `bI`:

```js
function coordsToViewport(x, y, ctx) {
  return [Math.round(x * ctx.viewportWidth  / ctx.screenshotWidth),
          Math.round(y * ctx.viewportHeight / ctx.screenshotHeight)];
}
```

Per-tab they cache `{viewportWidth, viewportHeight, screenshotWidth, screenshotHeight}` at
capture time, so agent-supplied coordinates are always in *screenshot* space and get mapped back
to *viewport* space on use. The agent never has to know about devicePixelRatio or the downscale.
This is the clean solution to the single most common source of misclicks.

They also verify it: after capture, the PNG/JPEG header is decoded and the real dimensions are
compared against the expected clip within ±1px before the context is trusted.

### A TOCTOU guard on every action

```js
async function checkUrlUnchanged(tabId, urlAtPermissionCheck, label) {
  const tab = await chrome.tabs.get(tabId);
  if (origin(urlAtPermissionCheck) !== origin(tab.url))
    return { error: `Security check failed: the page navigated to a different domain during ${label}. Re-read the tab state before retrying.` };
  return null;
}
```

Called by every mutating tool immediately *after* the permission check and *before* touching the
page. It closes the window where a page navigates itself between "user approved example.com" and
"we type the password". Ten lines, and it is the difference between a permission model and a
permission theater.

### Debugger attach is kept warm for 20 seconds

Attaching `chrome.debugger` is slow (they sleep 500ms after attach) and it shows the user a
yellow "being debugged" banner. So detach is deferred: when the last in-flight tool call for a
tab finishes, a 20s timer starts, and any new call cancels it. Rapid sequences pay the attach
cost once; an idle agent lets the banner disappear on its own.

### The tab group is the entire UI

Take the mechanism, not their encoding of it.

There is no dashboard. Status lives on the Chrome tab group itself, which is free, native,
unmissable, and costs no UI surface of its own. That part is right and worth copying.

What they do with it is not. State is carried by emoji prefixed onto the group title — `⌛`
running, `🔔` waiting on a permission decision, `✅` finished — while the group *color* is spent on
something else entirely: it is picked by counting colors already in use across the window and
taking the least-used one, purely so the agent's group looks distinct from your own groups.

That is backwards. Chrome hands you two channels on a tab group, and color is the one built for
state. Spending it on "be different" and then bolting glyphs onto the title to carry the actual
information means the title is now ugly *and* the color says nothing.

Put the state in the color and leave the title alone:

| `chrome.tabGroups.Color` | state |
|---|---|
| `GREY` | idle, nothing in flight |
| `BLUE` | a tool call is running |
| `RED` | waiting on a permission decision |
| `GREEN` | finished clean |

The title then stays a plain session name, which is also the thing you actually want to read
when four agent groups are open at once. `collapsed: true` is available too and is the honest
signal for "done, stop looking at me."

One implementation note regardless of encoding: their updates retry three times at 500ms,
because `chrome.tabGroups.update` races with the user dragging tabs around. Keep that.

### The phantom cursor

`agent-visual-indicator.js` injects a fake cursor at `z-index: 2147483646` that slides to each
click target with `transition: transform 180ms cubic-bezier(0.2, 0, 0, 1)`. Two stacked SVG
paths: a plain white/black one, and a Claude-orange (`#D97757`) one with a double drop-shadow
glow. It is `aria-hidden` and `pointer-events: none`, and it is explicitly hidden before every
click and screenshot (`hideIndicatorForToolUse` / `restoreIndicatorAfterToolUse`) so the agent
never sees or clicks its own cursor.

Worth noting mostly because getting the hide/restore right is the non-obvious part — an overlay
that shows up in your own screenshots is worse than no overlay.

### The macOS editing-command map

`pressKeyChord` carries a table mapping keys to macOS NSResponder commands, sent as CDP
`commands` on the keyDown:

```js
{ backspace: "deleteBackward", enter: "insertNewline", arrowup: "moveUp",
  home: "scrollToBeginningOfDocument", "shift+arrowleft": "moveLeftAndModifySelection",
  "ctrl+enter": "insertLineBreak", … }
```

On macOS Chrome routes editing keys through the responder chain, so a bare
`Input.dispatchKeyEvent` with the right keycode does nothing inside a text field. You have to
name the command. This table is what "arrow keys don't work on Mac" looks like after someone
finally fixed it, and you will need it too.

Typing itself maps each character to a keycode for keyDown/keyUp, and falls back to
`Input.insertText` for anything unmapped (emoji, CJK, accented characters).

### Dialogs are intercepted, not avoided

`Page.javascriptDialogOpening` is handled globally and answered with
`Page.handleJavaScriptDialog`, with a per-tab `beforeunload` policy and a waiter that also
resolves on `Page.frameNavigated` or debugger detach. The agent-facing docs still warn "do not
trigger alerts, they will wedge the session", which appears to be stale advice.

### MV3 keepalive via the offscreen document

`offscreen.js` ships unminified, comments intact:

```js
// SW keepalive — offscreen docs aren't subject to MV3's 30s idle kill. A
// message every 20s resets the SW's idle timer, keeping the bridge WS
// setInterval ping running under background throttle/freeze.
setInterval(() => {
  chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }).catch(() => {});
}, 20_000);
```

MV3 kills a service worker after 30s idle, which would drop a persistent WebSocket. An offscreen
document is exempt, so they keep one alive purely as a heartbeat source and lazily reuse it for
audio and GIF encoding. Belt and braces: there is *also* a `chrome.alarms` tick every 30s doing
the same job, because alarms survive the SW being killed and restart it.

### Batch failures report what they did and did not do

```
actions[3] (computer) failed: Permission denied (2 completed, 4 remaining)
```

and when the failure is a domain or navigation block specifically, prior results are **discarded
entirely** rather than returned partially:

```
actions[3] (navigate) failed: This site is blocked (2 prior results discarded; 5 not run)
```

Images from discarded steps are replaced with `[Image omitted due to error]` rather than
dropped silently. The agent always knows exactly how far the batch got.

### `find` is a nested model call

This one is a design decision rather than a trick, and it is worth knowing before you copy it.
`find` dumps the whole accessibility tree into a `small_fast` (Haiku-class) completion:

> Find ALL elements that match the user's query… Return up to 20 most relevant matches…
> `ref_X | role | name | type | reason why this matches`

and hand-parses the pipe-delimited lines back out, tagged `sampling_find_tool`. So every `find`
is a second inference billed to the user's account, with a whole-page prompt.

For your own build the interesting question is whether you want that dependency at all. A
sub-model call buys real fuzzy matching, but `read_page` with `filter:"interactive"` plus local
scoring gets a long way for free, and it does not fail when the API is unreachable.

### Small things

- **`stripExtensionInterference`.** When CDP attach fails with "Cannot access a chrome-extension://
  URL of different extension", they walk every frame including open *and closed* shadow roots
  (`chrome.dom.openOrClosedShadowRoot`), delete foreign extension iframes, and retry up to 4
  times with a 75ms settle. There is a kill switch at
  `chrome.storage.local.cicStripExtensionInterference = false`. Password managers are the usual
  culprit.
- **`javascript_tool` redacts its own output.** Returned values are walked to depth 5 and any key
  matching `/password|token|secret|api[_-]?key|auth|creden/i` is replaced. The agent gets the
  shape of the object without the credentials in its context.
- **The a11y tree redacts too**, at the source: `type=password`, `type=hidden`, and
  `autocomplete` of `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`,
  `cc-exp*` all report `[value redacted]`.
- **Page settle** is a 3s poll at 100ms for `tab.status !== "loading"`, with a cancellation hook,
  rather than a fixed sleep.
- **Truncation is at a line boundary**, and the note states the true full size so the agent can
  decide whether raising `max_chars` is worth it rather than guessing.
- **Refs are `WeakRef`s**, so a stale ref produces "element has been garbage collected" or
  "no longer in the document" instead of acting on a recycled node.

### One thing that looks wrong

The click routine gates all of its human-like delays behind:

```js
const a = typeof document !== "undefined" && document.visibilityState === "visible";
```

Tool execution runs in the MV3 service worker, where `document` is undefined. So `a` is false on
the normal path, and the `mouseMoved` promise is never awaited before `mousePressed` fires, and
the inter-click delays for double/triple clicks are skipped. It works for ordinary buttons
because CDP commands are ordered on the wire, but anything that depends on a real hover settling
first (menus that open on `mouseover`, tooltips) would be racy.

I have not tested this against a live page, so treat it as a strong reading of the code rather
than a confirmed bug. If you hit flaky menu clicks in your own build, await the move.
