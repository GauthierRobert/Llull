/** Minimal PNG / JPEG byte streams (headers only — enough for size parsing) as data URLs. */

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number): number[] => [(n >> 8) & 255, n & 255];

export function pngBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // signature
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52, // IHDR length + type
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0, // size, depth, color type, …
    0,
    0,
    0,
    0, // CRC (not checked)
  ]);
}

/** SOI, an APP0 segment, a fill byte, then SOF0 (or `sof` marker) with the frame size. */
export function jpegBytes(width: number, height: number, sof = 0xc0): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff, // fill byte
    0xff,
    sof,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export const pngDataUrl = (width: number, height: number): string => `data:image/png;base64,${base64(pngBytes(width, height))}`;

export const jpegDataUrl = (width: number, height: number): string => `data:image/jpeg;base64,${base64(jpegBytes(width, height))}`;
