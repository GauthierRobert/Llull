/** Image file headers (RV1 RV-M1): format, width and height of a PNG, JPEG or Radiance HDR file, read without decoding any pixel. */

export interface ImageHeader {
  readonly format: 'png' | 'jpeg' | 'hdr';
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Start-of-frame markers carry the size; C4 (huffman table), C8 (reserved) and CC (arithmetic table) do not. */
const JPEG_NON_FRAME = new Set([0xc4, 0xc8, 0xcc]);
const HDR_SCAN_BYTES = 65536;

const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;
const be16 = (bytes: Uint8Array, index: number): number => (at(bytes, index) << 8) | at(bytes, index + 1);
const be32 = (bytes: Uint8Array, index: number): number =>
  ((at(bytes, index) << 24) | (at(bytes, index + 1) << 16) | (at(bytes, index + 2) << 8) | at(bytes, index + 3)) >>> 0;

function pngHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  const chunk = String.fromCharCode(at(bytes, 12), at(bytes, 13), at(bytes, 14), at(bytes, 15));
  return chunk === 'IHDR' ? { format: 'png', width: be32(bytes, 16), height: be32(bytes, 20) } : null;
}

function jpegHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || at(bytes, 0) !== 0xff || at(bytes, 1) !== 0xd8) return null;
  let index = 2;
  while (index + 4 <= bytes.length) {
    if (at(bytes, index) !== 0xff) return null;
    const marker = at(bytes, index + 1);
    if (marker === 0xff) {
      index += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    const length = be16(bytes, index + 2);
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_FRAME.has(marker)) {
      return index + 9 <= bytes.length ? { format: 'jpeg', width: be16(bytes, index + 7), height: be16(bytes, index + 5) } : null;
    }
    if (marker === 0xd9 || marker === 0xda || length < 2) return null;
    index += 2 + length;
  }
  return null;
}

function hdrHeader(bytes: Uint8Array): ImageHeader | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, HDR_SCAN_BYTES)));
  if (!head.startsWith('#?RADIANCE') && !head.startsWith('#?RGBE')) return null;
  const match = /\n\s*\n[^\n]*?-Y\s+(\d+)\s+\+X\s+(\d+)/.exec(head);
  return match === null ? null : { format: 'hdr', width: Number(match[2]), height: Number(match[1]) };
}

/** Header of the image `bytes`, or null when it is not a PNG, a JPEG (any SOFn frame) or a Radiance `-Y h +X w` HDR file. Sizes may be 0 in a corrupt file: the caller checks. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return pngHeader(bytes) ?? jpegHeader(bytes) ?? hdrHeader(bytes);
}
