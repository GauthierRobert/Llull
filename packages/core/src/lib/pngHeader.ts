/** Size of a PNG from its first chunk, without decoding it (a host checks a picture it received is the size it asked for). */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** 8 signature bytes + length (4) + "IHDR" (4) + width (4) + height (4). */
const HEADER_BYTES = 24;
const IHDR = [73, 72, 68, 82];
const IHDR_DATA_BYTES = 13;

/** @failure not a PNG (signature), first chunk not a 13-byte IHDR, or a zero side -> null; never throws */
export function pngHeader(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (!SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== IHDR_DATA_BYTES || !IHDR.every((value, index) => bytes[12 + index] === value)) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
