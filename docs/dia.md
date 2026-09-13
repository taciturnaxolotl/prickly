# Notes on Dia (and other ArcCore browsers)

Dia is Chromium under an ArcCore shell, which mostly behaves but differs in
three ways that each cost an hour to find. Written down so they cost nothing
next time.

## Native messaging manifests live in Chrome's directory

Dia does **not** read `~/Library/Application Support/Dia/NativeMessagingHosts`,
nor the `User Data` variant, even though a stale Granola manifest sits in the
latter. It reads Chrome's:

```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
```

The giveaway was 1Password and Claude Code working in Dia while having no
manifest in any Dia directory. `strings` on `ArcCore` confirms it, listing
`/Library/Google/Chrome/NativeMessagingHosts` among its search paths.

Arc is the sibling case and behaves differently again: Claude installs to
`Arc/User Data/NativeMessagingHosts` there.

A manifest in the wrong place fails with `Specified native messaging host not
found.`, which reads like a name or id mismatch and sends you hunting in the
wrong direction.

## Synthesized input needs a visible tab

Chrome silently drops CDP `Input.dispatchMouseEvent` on a tab whose
`document.visibilityState` is `hidden`. The click reports success, the page
receives nothing, not even a `mousedown`. Screenshots still work on a hidden
tab, which makes it look like the coordinates are wrong rather than the tab
being asleep.

A tab grouped into a window you are already using is a background tab, so it
is hidden. A tab in its own window is visible even when the window is not
focused. That is why sessions default to their own window; it is not about
isolation, which the tab group already provides.

## tabs.update({active: true}) is not reliable

ArcCore keeps its own tab model, so activating a tab through the Chromium API
fails:

```
Tab not found for session ID: TabSessionID(value: 1080131565)
```

Forcing it can dissolve the Chromium tab group the session depends on. Treat
activation as best effort, warn when it fails, and let the caller open a
window instead.

## Diagnosing

The host's stderr is the only window into its side, and the browser discards
it. The generated launcher appends it to a log:

```sh
tail -f /tmp/prickly-host.log
```

To check the browser end without an agent:

```sh
bun run host/bin/prickly.ts browsers   # is anything connected
bun run host/bin/prickly.ts reload     # rebuild + reload, no browser UI
```
