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

export async function drag(tabId: number, opts: DragOptions): Promise<void> {
  const steps = Math.max(2, opts.steps ?? 8);
  const [fx, fy] = toViewport(tabId, opts.from.x, opts.from.y);
  const [tx, ty] = toViewport(tabId, opts.to.x, opts.to.y);
  const session = cdp(tabId);

  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: fx,
    y: fy,
    button: "none",
    buttons: 0,
  });
  await session.send("Input.dispatchDragEvent", {
    type: "dragEnter",
    x: fx,
    y: fy,
    data: { items: [], dragOperationsMask: 1 },
  }).catch(() => {
    // dragEnter is unsupported on some targets; the move sequence still works.
  });
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
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(fx + (tx - fx) * t),
      y: Math.round(fy + (ty - fy) * t),
      button: "left",
      buttons: 1,
    });
    await sleep(16);
  }

  await session.send("Input.dispatchDragEvent", {
    type: "dragOver",
    x: tx,
    y: ty,
    data: { items: [], dragOperationsMask: 1 },
  }).catch(() => {});
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: tx,
    y: ty,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await session.send("Input.dispatchDragEvent", {
    type: "drop",
    x: tx,
    y: ty,
    data: { items: [], dragOperationsMask: 1 },
  }).catch(() => {});
}

export async function scroll(
  tabId: number,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const [vx, vy] = toViewport(tabId, x, y);
  await cdp(tabId).send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: vx,
    y: vy,
    deltaX,
    deltaY,
  });
  await sleep(80);
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

function specFor(raw: string): KeySpec {
  const lower = raw.toLowerCase();

  if (lower.length === 1) {
    const code = /[a-z]/.test(lower) ? `Key${lower.toUpperCase()}` : `Digit${lower}`;
    return {
      key: lower,
      code,
      windowsVirtualKeyCode: lower.toUpperCase().charCodeAt(0),
      text: lower,
    };
  }

  const code = `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  return {
    key: code,
    code: KEY_CODES[lower] !== undefined ? `Named${code}` : code,
    windowsVirtualKeyCode: KEY_CODES[lower] ?? 0,
  };
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
      ...(commands ? { commands: [{ name: commands }] } : {}),
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: bits,
      ...(commands ? { commands: [{ name: commands }] } : {}),
    });
    if (i + 1 < repeat) await sleep(30);
  }
}

/**
 * Types a string. Characters that map to a keycode go through the keyboard so
 * keydown handlers fire; everything else (emoji, CJK, accents) goes through
 * insertText, because synthesizing those is a losing game.
 */
export async function typeText(tabId: number, text: string): Promise<void> {
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
    // Printable ASCII, minus the space we would rather send as text anyway.
    if (/^[ -~]$/.test(char)) {
      await pressKeyChord(tabId, char);
      await sleep(8);
      continue;
    }
    pending += char;
    if (pending.length >= 64) await flush();
  }
  await flush();
}

/** Page-zoom chords would desync the screenshot mapping, so they are refused. */
const FORBIDDEN_CHORDS = ["cmd+=", "cmd+-", "cmd+0", "ctrl+=", "ctrl+-", "ctrl+0"];

export function forbiddenChord(chord: string): string | null {
  const normalized = chord.toLowerCase().replace(/\s+/g, "");
  const hit = FORBIDDEN_CHORDS.find((f) => normalized === f || normalized.startsWith(f));
  if (!hit) return null;
  return (
    `Page zoom (${hit}) is refused: it would change the coordinate mapping and every ` +
    `later click would land in the wrong place. Use a region screenshot to see detail instead.`
  );
}
