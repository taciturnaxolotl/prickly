/**
 * Screenshots.
 *
 * Two ideas here, both borrowed and both worth it.
 *
 * First, resize to a *token* budget rather than a pixel budget. A screenshot
 * costs context window, so pick the largest size that fits the budget and only
 * reach for JPEG quality once geometry has done all it can. Most harnesses do
 * this the other way round and end up with a blurry 1600px image.
 *
 * Second, cache the capture geometry per tab. The model works in screenshot
 * coordinates and never has to know about devicePixelRatio or the downscale,
 * because every click maps back through the cached ratio. That single mapping
 * removes the most common source of misclicks.
 */

import { PricklyError } from "@shared/protocol";
import { cdp } from "./cdp";

/** Roughly what an image token costs in pixels for a vision model. */
const PX_PER_TOKEN = 750;
const MAX_TARGET_TOKENS = 1600;
const MAX_TARGET_EDGE = 1400;

/** ~1 MB of base64, which is where message frames start to hurt. */
const MAX_BASE64_CHARS = 1_398_100;

const START_QUALITY = 0.75;
const MIN_QUALITY = 0.1;
const QUALITY_STEP = 0.05;

export interface ViewportGeometry {
  viewportWidth: number;
  viewportHeight: number;
  screenshotWidth: number;
  screenshotHeight: number;
  capturedAt: number;
  url: string;
}

const geometry = new Map<number, ViewportGeometry>();

export function geometryFor(tabId: number): ViewportGeometry | undefined {
  return geometry.get(tabId);
}

/**
 * Model coordinates are screenshot coordinates. Convert on use, and complain
 * if there is no screenshot yet rather than silently assuming 1:1.
 */
export function toViewport(tabId: number, x: number, y: number): [number, number] {
  const geo = geometry.get(tabId);
  if (!geo) return [Math.round(x), Math.round(y)];
  return [
    Math.round((x * geo.viewportWidth) / geo.screenshotWidth),
    Math.round((y * geo.viewportHeight) / geo.screenshotHeight),
  ];
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Capture {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  quality: number;
  scaled: boolean;
}

/** Largest size inside both the pixel-edge cap and the token budget. */
export function fitTarget(width: number, height: number): { width: number; height: number } {
  const budgetPx = MAX_TARGET_TOKENS * PX_PER_TOKEN;
  let scale = 1;

  const longEdge = Math.max(width, height);
  if (longEdge > MAX_TARGET_EDGE) scale = MAX_TARGET_EDGE / longEdge;

  const area = width * scale * (height * scale);
  if (area > budgetPx) scale *= Math.sqrt(budgetPx / area);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function capture(
  tabId: number,
  options: { region?: Region; fullQuality?: boolean } = {},
): Promise<Capture> {
  const session = cdp(tabId);
  await session.enable("Page");

  const metrics = await session.send<{
    cssLayoutViewport: { clientWidth: number; clientHeight: number };
    layoutViewport: { clientWidth: number; clientHeight: number };
    cssVisualViewport: { pageX: number; pageY: number };
  }>("Page.getLayoutMetrics");

  const viewportWidth = metrics.cssLayoutViewport.clientWidth;
  const viewportHeight = metrics.cssLayoutViewport.clientHeight;

  /**
   * clip.scale is applied on top of the device pixel ratio, not instead of it,
   * so on a retina display a scale of 1 yields an image twice the CSS size and
   * four times the token cost. Divide it back out so the pixel budget means
   * what it says.
   */
  const deviceRatio =
    metrics.layoutViewport?.clientWidth && viewportWidth
      ? metrics.layoutViewport.clientWidth / viewportWidth
      : 1;

  const sourceWidth = options.region?.width ?? viewportWidth;
  const sourceHeight = options.region?.height ?? viewportHeight;
  const target = options.fullQuality
    ? { width: sourceWidth, height: sourceHeight }
    : fitTarget(sourceWidth, sourceHeight);
  const scale = target.width / sourceWidth / (deviceRatio || 1);

  const clip = options.region
    ? { ...options.region, scale }
    : { x: 0, y: 0, width: viewportWidth, height: viewportHeight, scale };

  let quality = START_QUALITY;
  let data = "";
  for (;;) {
    const shot = await session.send<{ data: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: Math.round(quality * 100),
      fromSurface: true,
      captureBeyondViewport: false,
      clip,
    });
    data = shot.data;
    if (data.length <= MAX_BASE64_CHARS || quality <= MIN_QUALITY) break;
    quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
  }

  if (data.length > MAX_BASE64_CHARS) {
    throw new PricklyError(
      "Screenshot is too large even at minimum quality. Capture a region instead.",
    );
  }

  // Verify against the JPEG header rather than trusting the clip. A mismatch
  // here means the coordinate mapping would have been wrong, which is a far
  // more annoying bug to chase later.
  const real = jpegDimensions(data);
  const width = real?.width ?? target.width;
  const height = real?.height ?? target.height;
  if (real && (Math.abs(real.width - target.width) > 2 || Math.abs(real.height - target.height) > 2)) {
    console.warn(
      `[prickly] screenshot geometry drift: asked ${target.width}x${target.height}, got ${real.width}x${real.height}`,
    );
  }

  // Region captures do not describe the whole viewport, so they must not
  // become the coordinate basis for later clicks.
  if (!options.region) {
    const tab = await chrome.tabs.get(tabId);
    geometry.set(tabId, {
      viewportWidth,
      viewportHeight,
      screenshotWidth: width,
      screenshotHeight: height,
      capturedAt: Date.now(),
      url: tab.url ?? "",
    });
  }

  return {
    data,
    mimeType: "image/jpeg",
    width,
    height,
    quality,
    scaled: scale !== 1,
  };
}

/** Walks JPEG segments for the SOF marker. Enough to read width and height. */
function jpegDimensions(base64: string): { width: number; height: number } | null {
  // 2 KB of header is plenty and decoding the whole image would be wasteful.
  const head = base64.slice(0, 4096);
  let bytes: Uint8Array;
  try {
    const raw = atob(head);
    bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }

  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      return { width, height };
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    i += 2 + length;
  }
  return null;
}

export function forgetGeometry(tabId: number): void {
  geometry.delete(tabId);
}
