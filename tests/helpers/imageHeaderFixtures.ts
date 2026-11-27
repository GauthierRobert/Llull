/** Minimal image files for the appearance tests: only the header bytes a texture import reads, generated, no binaries. */

import { uint8ArrayToBase64 } from '@lib/base64';

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];

/** A PNG signature + IHDR chunk (8-bit RGBA) of `width` x `height`. */
export function pngBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

/** A baseline JPEG head: SOI, a JFIF APP0 segment, then SOF0 of `width` x `height`. `marker` picks another SOFn. */
export function jpegBytes(width: number, height: number, marker = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, ...u16(1), ...u16(1), 0, 0];
  const sof = [0xff, marker, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

/** A Radiance RGBE head: `#?RADIANCE`, FORMAT line, blank line, `-Y height +X width`. */
export function hdrBytes(width: number, height: number): Uint8Array {
  return new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
}

export const toBase64 = (bytes: Uint8Array): string => uint8ArrayToBase64(bytes);

/** In-memory image asset port that counts writes. */
export function memoryImageAssets(
  files: Record<string, Uint8Array> = {},
  sha: (bytes: Uint8Array) => string,
): { readImage(key: string): Uint8Array | null; writeImage(bytes: Uint8Array): string; readonly files: Record<string, Uint8Array> } {
  return {
    files,
    readImage: (key) => (Object.hasOwn(files, key) ? (files[key] ?? null) : null),
    writeImage(bytes) {
      const key = sha(bytes);
      files[key] = bytes;
      return key;
    },
  };
}
