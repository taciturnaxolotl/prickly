/**
 * Length-prefixed JSON framing.
 *
 * 4-byte little-endian length, then UTF-8 JSON. This is Chrome's native
 * messaging format, which we do not get to choose on the stdio hop, so the
 * socket hop uses it too.
 */

import { MAX_FRAME_BYTES, type Frame } from "./protocol";

export function encodeFrame(frame: Frame): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(frame));
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${body.length} bytes`);
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

/**
 * Incremental reader. Sockets hand you arbitrary chunk boundaries, so frames
 * arrive split down the middle roughly as often as not.
 */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: Frame[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const len = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        4,
      ).getUint32(0, true);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`frame length ${len} exceeds maximum; stream desynced`);
      }
      if (this.buffer.length < 4 + len) break;

      const body = this.buffer.subarray(4, 4 + len);
      frames.push(JSON.parse(new TextDecoder().decode(body)) as Frame);
      this.buffer = this.buffer.subarray(4 + len);
    }
    return frames;
  }

  get pending(): number {
    return this.buffer.length;
  }
}
