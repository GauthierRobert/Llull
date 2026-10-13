/**
 * Raster data URLs (`data:image/png;base64,…`, `data:image/jpeg;base64,…`): format check and the intrinsic pixel size read from the PNG
 * IHDR chunk / JPEG SOF marker. No DOM image decoding.
 */

import { base64ToUint8Array } from './base64';

type RasterMime = 'image/png' | 'image/jpeg';

export type ParsedImageDataUrl =
  | { readonly ok: true; readonly mime: RasterMime; readonly pixelWidth: number; readonly pixelHeight: number }
  | { readonly ok: false; readonly error: string };

const DATA_URL_PATTERN = /^data:(image\/png|image\/jpe?g);base64,/;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const fail = (error: string): ParsedImageDataUrl => ({ ok: false, error });

function uint16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function uint32(bytes: Uint8Array, at: number): number {
  return uint16(bytes, at) * 65536 + uint16(bytes, at + 2);
}

/** [width, height] from the IHDR chunk that must follow the 8-byte signature. */
function pngSize(bytes: Uint8Array): readonly [number, number] | null {
  const signed = PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
  if (!signed || bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  return [uint32(bytes, 16), uint32(bytes, 20)];
}

/** SOFn markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** [width, height] from the first SOFn segment, walking the marker segments after SOI. */
function jpegSize(bytes: Uint8Array): readonly [number, number] | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (isStartOfFrame(marker)) {
      // Marker (2) + length (2) + precision (1) + height (2) + width (2).
      return at + 8 < bytes.length ? [uint16(bytes, at + 7), uint16(bytes, at + 5)] : null;
    }
    at += 2 + uint16(bytes, at + 2);
  }
  return null;
}

/**
 * Format and pixel size of a base64 PNG/JPEG data URL.
 * @failure not a png/jpeg base64 data URL, invalid base64, unreadable header, zero size -> { ok: false }
 */
export function parseImageDataUrl(dataUrl: string): ParsedImageDataUrl {
  const header = DATA_URL_PATTERN.exec(dataUrl);
  if (header === null) return fail('dataUrl must start with "data:image/png;base64," or "data:image/jpeg;base64,"');
  const bytes = base64ToUint8Array(dataUrl.slice(header[0].length));
  if (bytes === null) return fail('dataUrl payload is not valid base64');
  const mime: RasterMime = header[1] === 'image/png' ? 'image/png' : 'image/jpeg';
  const size = mime === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  if (size === null) return fail(`dataUrl payload is not a readable ${mime} file`);
  const [pixelWidth, pixelHeight] = size;
  if (pixelWidth <= 0 || pixelHeight <= 0) return fail(`image has a zero pixel size (${pixelWidth}×${pixelHeight})`);
  return { ok: true, mime, pixelWidth, pixelHeight };
}
