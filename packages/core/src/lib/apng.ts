/**
 * Animated PNG (APNG, PNG 3rd edition) from complete PNG frames: signature, IHDR, acTL, then per frame an fcTL and its pixels (IDAT for frame 0, fdAT
 * for the others), sequence numbers 0, 1, 2… shared by fcTL and fdAT. Every frame is the full canvas, replaces what is below it and stays (dispose NONE,
 * blend SOURCE), shown for 1 / fps seconds; the animation loops forever. Pure and byte-deterministic: the frames' compressed pixels are copied, never re-encoded.
 */

import { pngChunk } from './png';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const type4 = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

interface ParsedFrame {
  readonly header: Uint8Array;
  readonly pixels: Uint8Array;
}

/** IHDR data and the concatenated IDAT data of a PNG, or null when it is not a well-formed PNG with pixels. */
function parseFrame(png: Uint8Array): ParsedFrame | null {
  if (png.length < 8 || SIGNATURE.some((byte, k) => png[k] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let header: Uint8Array | null = null;
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = type4(png, offset + 4);
    if (offset + 12 + length > png.length) return null;
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = data;
    else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (header === null || header.length !== 13 || parts.length === 0) return null;
  const pixels = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    pixels.set(part, at);
    at += part.length;
  }
  return { header, pixels };
}

function frameControl(sequence: number, width: number, height: number, fps: number): Uint8Array {
  const data = new Uint8Array(26);
  const view = new DataView(data.buffer);
  view.setUint32(0, sequence);
  view.setUint32(4, width);
  view.setUint32(8, height);
  view.setUint16(20, 1);
  view.setUint16(22, fps);
  return data;
}

/**
 * The APNG of `frames` (complete PNGs of the same size) at `fps` frames per second (1..65535), looping forever; null when there is no frame,
 * a frame is not a PNG, the sizes differ or `fps` is not an integer in range.
 */
export function encodeApng(frames: readonly Uint8Array[], fps: number): Uint8Array | null {
  if (frames.length === 0 || !Number.isInteger(fps) || fps < 1 || fps > 65535) return null;
  const parsed = frames.map(parseFrame);
  const first = parsed[0];
  if (first === undefined || first === null) return null;
  if (parsed.some((frame) => frame === null || frame.header.some((byte, k) => byte !== first.header[k]))) return null;
  const view = new DataView(first.header.buffer, first.header.byteOffset, first.header.byteLength);
  const [width, height] = [view.getUint32(0), view.getUint32(4)];
  const control = new Uint8Array(8);
  new DataView(control.buffer).setUint32(0, frames.length);
  const parts: Uint8Array[] = [new Uint8Array(SIGNATURE), pngChunk('IHDR', first.header), pngChunk('acTL', control)];
  let sequence = 0;
  parsed.forEach((frame, k) => {
    parts.push(pngChunk('fcTL', frameControl(sequence, width, height, fps)));
    sequence += 1;
    if (k === 0) parts.push(pngChunk('IDAT', first.pixels));
    else {
      const data = new Uint8Array(4 + (frame?.pixels.length ?? 0));
      new DataView(data.buffer).setUint32(0, sequence);
      data.set(frame?.pixels ?? new Uint8Array(0), 4);
      parts.push(pngChunk('fdAT', data));
      sequence += 1;
    }
  });
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
