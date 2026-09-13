/**
 * Mouse and keyboard input, over CDP.
 *
 * Two non-obvious things live here.
 *
 * On macOS Chrome routes editing keys through the NSResponder chain, so a bare
 * Input.dispatchKeyEvent with the right keycode does nothing inside a text
 * field. You have to name the command. The table below is what "arrow keys do
 * not work on Mac" looks like after it has been fixed.
 *
 * And a hover has to settle before the click that depends on it. CDP commands
 * are ordered on the wire, which hides the problem for ordinary buttons, but a
 * menu that opens on mouseover will not be open yet when the press lands.
 * Await the move.
 */

import { PricklyError } from "@shared/protocol";
import { cdp, sleep } from "../core/cdp";
import { toViewport } from "../core/screenshot";

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  win: 4,
  command: 4,
  shift: 8,
};

export function modifiersToBits(spec: string | undefined): number {
  if (!spec) return 0;
  return spec
    .split("+")
    .map((part) => MODIFIER_BITS[part.trim().toLowerCase()] ?? 0)
    .reduce((a, b) => a | b, 0);
}

async function mouse(
  tabId: number,
  type: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const [vx, vy] = toViewport(tabId, x, y);
  await cdp(tabId).send("Input.dispatchMouseEvent", {
    type,
    x: vx,
    y: vy,
    ...extra,
  });
}

export interface ClickOptions {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  modifiers?: string;
  clickCount?: number;
  /** Extra settle time between clicks, for double and triple. */
  repeatDelayMs?: number;
}

export async function click(tabId: number, opts: ClickOptions): Promise<void> {
  await wakeRendererForInput(tabId);
  const button = opts.button ?? "left";
  const count = opts.clickCount ?? 1;
  const bits = modifiersToBits(opts.modifiers);

  // Move first, and wait for it. Anything listening on mouseover needs this.
  await mouse(tabId, "mouseMoved", opts.x, opts.y, { button: "none", buttons: 0, modifiers: bits });
  await sleep(30);

  for (let i = 1; i <= count; i++) {
    await mouse(tabId, "mousePressed", opts.x, opts.y, {
      button,
      buttons: button === "right" ? 2 : 1,
      clickCount: i,
      modifiers: bits,
    });
    await mouse(tabId, "mouseReleased", opts.x, opts.y, {
      button,
      buttons: 0,
      clickCount: i,
      modifiers: bits,
    });
    if (i < count) await sleep(opts.repeatDelayMs ?? 40);
  }
}

export async function hover(tabId: number, x: number, y: number, modifiers?: string): Promise<void> {
  await wakeRendererForInput(tabId);
  await mouse(tabId, "mouseMoved", x, y, {
    button: "none",
    buttons: 0,
    modifiers: modifiersToBits(modifiers),
  });
  await sleep(50);
}

export interface DragOptions {
  from: Point;
  to: Point;
  /** Extra waypoints make HTML5 drag-and-drop implementations behave. */
  steps?: number;
}

/**
 * Drags from one point to another, completing an HTML5 drag properly.
 *
 * A plain press-move-release looks right and silently fails: Chrome promotes
 * the synthetic press into a native drag session, then ends it with `dragend`
 * and no `drop`, so every HTML5 drop target no-ops. The fix is to intercept the
 * drag, take the real payload Chrome hands over, and deliver it at the target
 * ourselves.
 *
 * Interception only applies to real HTML5 drags. Sliders, canvases, and custom
 * mouse-driven reordering never produce a payload, so those fall back to the
 * ordinary press-move-release, which is what they actually want.
 */
export async function drag(
  tabId: number,
  opts: DragOptions,
): Promise<{ html5: boolean; changed: boolean }> {
  const steps = Math.max(2, opts.steps ?? 8);
  const [fx, fy] = toViewport(tabId, opts.from.x, opts.from.y);
  const [tx, ty] = toViewport(tabId, opts.to.x, opts.to.y);
  const session = cdp(tabId);
  await wakeRendererForInput(tabId);

  let payload: unknown = null;
  const stopListening = session.on("Input.dragIntercepted", (params) => {
    payload = (params as { data?: unknown }).data ?? null;
  });

  const move = (x: number, y: number, buttons: number) =>
    session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(x),
      y: Math.round(y),
      button: buttons ? "left" : "none",
      buttons,
    });

  try {
    await session.send("Input.setInterceptDrags", { enabled: true }).catch(() => {});

    await move(fx, fy, 0);
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fx,
      y: fy,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await move(fx + (tx - fx) * t, fy + (ty - fy) * t, 1);
      await sleep(16);
      if (payload) break; // Chrome handed over a drag; finish it as a drag.
    }

    if (payload) {
      const data = payload as Record<string, unknown>;
      for (const type of ["dragEnter", "dragOver", "drop"] as const) {
        await session.send("Input.dispatchDragEvent", { type, x: tx, y: ty, data });
      }
      // Release the button so the page does not think one is still held.
      await session
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: tx,
          y: ty,
          button: "left",
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => {});
      return { html5: true, changed: true };
    }

    // Not an HTML5 drag: finish the plain mouse gesture. Snapshot the target
    // area first so we can tell a drag that did something from one that the
    // page ignored, instead of always claiming it dragged.
    const fingerprint = () =>
      session
        .send<{ result: { value?: string } }>("Runtime.evaluate", {
          expression: `(() => { const el = document.elementFromPoint(${Math.round(tx)}, ${Math.round(ty)});
            if (!el) return "";
            const v = (el as HTMLInputElement).value;
            return (v === undefined ? "" : String(v)) + "|" + el.getBoundingClientRect().x + "|" + (el.className || ""); })()`,
          returnByValue: true,
        })
        .then((r) => r.result.value ?? "")
        .catch(() => "");
    const before = await fingerprint();
    await move(tx, ty, 1);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: tx,
      y: ty,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(60);
    const after = await fingerprint();
    return { html5: false, changed: before !== after };
  } finally {
    stopListening();
    await session.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}

export async function scroll(
  tabId: number,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<{ moved: number; atTop: boolean; atBottom: boolean }> {
  const [vx, vy] = toViewport(tabId, x, y);
  const session = cdp(tabId);

  // Scroll by moving the scrollable element under the point directly, not by
  // dispatching a synthetic wheel event. CDP Input.dispatchMouseEvent with
  // type "mouseWheel" never resolves on some Chromium forks (Dia/ArcCore), so
  // it would hang the whole call. Driving scrollTop through Runtime.evaluate is
  // reliable everywhere and can report exactly how far it moved.
  const r = await session.send<{
    result: { value?: { moved: number; atTop: boolean; atBottom: boolean } };
  }>("Runtime.evaluate", {
    expression: `(() => {
      let el = document.elementFromPoint(${vx}, ${vy});
      while (el) {
        const s = getComputedStyle(el);
        const scrollsY = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight;
        const scrollsX = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth;
        if ((${deltaY} !== 0 && scrollsY) || (${deltaX} !== 0 && scrollsX)) break;
        el = el.parentElement;
      }
      const target = el || document.scrollingElement || document.documentElement;
      const beforeY = target.scrollTop, beforeX = target.scrollLeft;
      target.scrollBy(${deltaX}, ${deltaY});
      const movedY = target.scrollTop - beforeY, movedX = target.scrollLeft - beforeX;
      const moved = Math.abs(movedY) >= Math.abs(movedX) ? movedY : movedX;
      const atTop = target.scrollTop <= 0;
      const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
      return { moved: Math.round(moved), atTop, atBottom };
    })()`,
    returnByValue: true,
  });
  await sleep(80);
  return r.result.value ?? { moved: 0, atTop: false, atBottom: false };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * macOS NSResponder editing commands, keyed by the chord that triggers them.
 * Without these, CDP key events for editing keys are ignored inside text
 * fields on macOS.
 */
const MAC_COMMANDS: Record<string, string> = {
  backspace: "deleteBackward",
  delete: "deleteForward",
  enter: "insertNewline",
  return: "insertNewline",
  tab: "insertTab",
  escape: "cancelOperation",
  arrowleft: "moveLeft",
  arrowright: "moveRight",
  arrowup: "moveUp",
  arrowdown: "moveDown",
  home: "scrollToBeginningOfDocument",
  end: "scrollToEndOfDocument",
  pageup: "scrollPageUp",
  pagedown: "scrollPageDown",
  "cmd+arrowleft": "moveToBeginningOfLine",
  "cmd+arrowright": "moveToEndOfLine",
  "cmd+arrowup": "moveToBeginningOfDocument",
  "cmd+arrowdown": "moveToEndOfDocument",
  "shift+arrowleft": "moveLeftAndModifySelection",
  "shift+arrowright": "moveRightAndModifySelection",
  "shift+arrowup": "moveUpAndModifySelection",
  "shift+arrowdown": "moveDownAndModifySelection",
  "shift+home": "moveToBeginningOfDocumentAndModifySelection",
  "shift+end": "moveToEndOfDocumentAndModifySelection",
  "cmd+shift+arrowleft": "moveToBeginningOfLineAndModifySelection",
  "cmd+shift+arrowright": "moveToEndOfLineAndModifySelection",
  "alt+arrowleft": "moveWordLeft",
  "alt+arrowright": "moveWordRight",
  "alt+shift+arrowleft": "moveWordLeftAndModifySelection",
  "alt+shift+arrowright": "moveWordRightAndModifySelection",
  "alt+backspace": "deleteWordBackward",
  "alt+delete": "deleteWordForward",
  "ctrl+enter": "insertLineBreak",
  "cmd+backspace": "deleteToBeginningOfLine",
  "cmd+a": "selectAll",
  "cmd+c": "copy",
  "cmd+v": "paste",
  "cmd+x": "cut",
  "cmd+z": "undo",
  "cmd+shift+z": "redo",
};

const KEY_CODES: Record<string, number> = {
  backspace: 8,
  tab: 9,
  enter: 13,
  return: 13,
  shift: 16,
  control: 17,
  ctrl: 17,
  alt: 18,
  option: 18,
  pause: 19,
  capslock: 20,
  escape: 27,
  esc: 27,
  space: 32,
  pageup: 33,
  pagedown: 34,
  end: 35,
  home: 36,
  arrowleft: 37,
  arrowup: 38,
  arrowright: 39,
  arrowdown: 40,
  insert: 45,
  delete: 46,
  meta: 91,
  cmd: 91,
  command: 91,
  win: 91,
  f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117,
  f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
};

const isMac = (): boolean =>
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode?: number;
  text?: string;
}

/**
 * DOM identity for a named key: what `event.key` and `event.code` must be.
 *
 * These are exact, case-sensitive strings from the UI Events spec. Deriving
 * them by capitalising the first letter produced "Arrowdown" and a nonsense
 * code, which Chrome discarded, so pages reading `e.key === "ArrowDown"` (every
 * modern menu, combobox, and listbox) saw nothing at all while the tool
 * reported success.
 */
const NAMED_KEYS: Record<string, { key: string; code: string; vk: number }> = {
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  enter: { key: "Enter", code: "Enter", vk: 13 },
  return: { key: "Enter", code: "Enter", vk: 13 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  // The spec says a space key reports a literal space, not the word.
  space: { key: " ", code: "Space", vk: 32 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  capslock: { key: "CapsLock", code: "CapsLock", vk: 20 },
  shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  control: { key: "Control", code: "ControlLeft", vk: 17 },
  ctrl: { key: "Control", code: "ControlLeft", vk: 17 },
  alt: { key: "Alt", code: "AltLeft", vk: 18 },
  option: { key: "Alt", code: "AltLeft", vk: 18 },
  meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  cmd: { key: "Meta", code: "MetaLeft", vk: 91 },
  command: { key: "Meta", code: "MetaLeft", vk: 91 },
  win: { key: "Meta", code: "MetaLeft", vk: 91 },
};
for (let n = 1; n <= 12; n++) {
  NAMED_KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n };
}

/** Physical codes for punctuation, so `event.code` is right for those too. */
const PUNCT_CODES: Record<string, string> = {
  "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
  "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma",
  ".": "Period", "/": "Slash", "`": "Backquote", " ": "Space",
};

function specFor(raw: string): KeySpec {
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      ...(named.key === " " ? { text: " " } : {}),
    };
  }

  if (raw.length === 1) {
    const lower = raw.toLowerCase();
    const code = /[a-z]/.test(lower)
      ? `Key${lower.toUpperCase()}`
      : /[0-9]/.test(lower)
        ? `Digit${lower}`
        : (PUNCT_CODES[lower] ?? "");
    return {
      key: raw,
      code,
      windowsVirtualKeyCode: lower.toUpperCase().charCodeAt(0),
      text: raw,
    };
  }

  // Unknown name: pass it through rather than inventing a bogus code.
  return { key: raw, code: "", windowsVirtualKeyCode: 0 };
}


/**
 * A chord like "cmd+shift+k" or a single key. `commands` is what makes
 * editing keys land on macOS.
 */
export async function pressKeyChord(
  tabId: number,
  chord: string,
  repeat = 1,
): Promise<void> {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new PricklyError("Empty key chord", "bad_params");

  const key = parts.pop()!;
  const modifiers = parts.join("+");
  const bits = modifiersToBits(modifiers) | (parts.includes("shift") ? 8 : 0);
  const spec = specFor(key);

  const normalized = [...parts.sort(), key].join("+");
  const commands = isMac() ? MAC_COMMANDS[normalized] ?? MAC_COMMANDS[key] : undefined;

  await wakeRendererForInput(tabId);
  const session = cdp(tabId);
  for (let i = 0; i < Math.min(repeat, 100); i++) {
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: bits,
      ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
      ...(commands ? { commands: [commands] } : {}),
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: bits,
      ...(commands ? { commands: [commands] } : {}),
    });
    if (i + 1 < repeat) await sleep(30);
  }
}

/**
 * Types a string. Characters that map to a keycode go through the keyboard so
 * keydown handlers fire; everything else (emoji, CJK, accents) goes through
 * insertText, because synthesizing those is a losing game.
 */
/**
 * Wakes a background tab's renderer so it will accept key events.
 *
 * Measured, not guessed: on a tab that is not the active one, input events
 * dispatch without error and are silently dropped. Forcing a frame with a tiny
 * screenshot makes the very next event land.
 *
 * This bites the first mouse event after a navigation too, not just the
 * keyboard: the click is swallowed, the tool reports success, and the page
 * never sees it. Every input entry point wakes the renderer first.
 */
async function wakeRendererForInput(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return;
    await cdp(tabId).send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 1,
      clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 },
    });
  } catch {
    // Not fatal: on a foreground tab input works regardless.
  }
}

/**
 * Best-effort physical key identity for a character, so handlers that read
 * `code`/`keyCode` still work. Omitted for anything unmapped; the literal
 * `text` is what actually inserts the character.
 */
function charIdentity(char: string): { code: string; vk: number } | null {
  if (/^[a-zA-Z]$/.test(char)) {
    return { code: `Key${char.toUpperCase()}`, vk: char.toUpperCase().charCodeAt(0) };
  }
  if (/^[0-9]$/.test(char)) return { code: `Digit${char}`, vk: char.charCodeAt(0) };
  if (char === " ") return { code: "Space", vk: 32 };
  // Punctuation gets its physical key too, so an editor reading event.code
  // sees the same thing a real keyboard would produce.
  const punct = PUNCT_CODES[char];
  if (punct) return { code: punct, vk: char.charCodeAt(0) };
  return null;
}

/**
 * Types one character as a real key event.
 *
 * The character travels in `text`, never through chord parsing. Routing
 * characters through the chord parser was a real bug: it split on "+",
 * lowercased, and dropped whitespace, so a space raised "Empty key chord",
 * capitals came out lowercase, and punctuation picked up a nonsense keycode
 * (a period became keycode 46, Delete). Passing the literal character keeps
 * keydown/keypress firing for page handlers while inserting exactly what was
 * asked for.
 */
async function typeChar(tabId: number, char: string): Promise<void> {
  const id = charIdentity(char);
  const common = id
    ? { code: id.code, windowsVirtualKeyCode: id.vk, nativeVirtualKeyCode: id.vk }
    : {};
  const session = cdp(tabId);
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: char,
    text: char,
    unmodifiedText: char,
    ...common,
  });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: char, ...common });
}

/**
 * Types a string. Printable characters go through real key events so pages
 * that listen for keydown react; anything a key event cannot represent (emoji,
 * CJK, combining marks) is batched into insertText.
 */
export async function typeText(tabId: number, text: string): Promise<void> {
  await wakeRendererForInput(tabId);
  const session = cdp(tabId);
  let pending = "";

  const flush = async (): Promise<void> => {
    if (!pending) return;
    await session.send("Input.insertText", { text: pending });
    pending = "";
  };

  for (const char of text) {
    if (char === "\n") {
      await flush();
      await pressKeyChord(tabId, "enter");
      continue;
    }
    if (char === "\t") {
      await flush();
      await pressKeyChord(tabId, "tab");
      continue;
    }
    // Printable ASCII, space included, as literal key events.
    if (/^[ -~]$/.test(char)) {
      await flush();
      await typeChar(tabId, char);
      continue;
    }
    pending += char;
    if (pending.length >= 64) await flush();
  }
  await flush();
}

/** Page-zoom chords would desync the screenshot mapping, so they are refused. */
const FORBIDDEN_CHORDS = [
  "cmd+=", "cmd+-", "cmd+0", "cmd+plus", "cmd+minus",
  "ctrl+=", "ctrl+-", "ctrl+0", "ctrl+plus", "ctrl+minus",
  "meta+=", "meta+-", "meta+0", "meta+plus", "meta+minus",
];

/**
 * Whether every part of a chord is a key we can actually send.
 *
 * Unknown names used to be dispatched as nothing at all and reported back as
 * if they had worked, so a typo was indistinguishable from a real keypress.
 * It also left a hole in the zoom guard: "cmd+=" was refused while "cmd+plus"
 * sailed through and silently did nothing.
 */
export function unknownKeyName(chord: string): string | null {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return `"${chord}" is not a key.`;
  const key = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1);

  const badModifier = modifiers.find((m) => MODIFIER_BITS[m] === undefined);
  if (badModifier) {
    return `"${badModifier}" is not a modifier. Use ctrl, shift, alt, or cmd (meta).`;
  }
  if (NAMED_KEYS[key] || key.length === 1) return null;

  const known = Object.keys(NAMED_KEYS).sort();
  const near = known.filter((k) => k.startsWith(key.slice(0, 3)));
  return (
    `"${key}" is not a key name. ` +
    (near.length ? `Did you mean ${near.slice(0, 3).join(", ")}? ` : "") +
    `Use a single character, or one of: ${known.slice(0, 18).join(", ")}...`
  );
}

export function forbiddenChord(chord: string): string | null {
  const normalized = chord.toLowerCase().replace(/\s+/g, "");
  const hit = FORBIDDEN_CHORDS.find((f) => normalized === f || normalized.startsWith(f));
  if (!hit) return null;
  return (
    `Page zoom (${hit}) is refused: it would change the coordinate mapping and every ` +
    `later click would land in the wrong place. Use a region screenshot to see detail instead.`
  );
}
