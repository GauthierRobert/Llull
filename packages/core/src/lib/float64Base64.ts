import { base64ToUint8Array, uint8ArrayToBase64 } from './base64';

/** Base64 of the little-endian float64 bytes of `values` (the same text on every platform). */
export function float64ToBase64(values: Float64Array): string {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat64(i * 8, values[i] ?? 0, true);
  return uint8ArrayToBase64(bytes);
}

/** Decoded little-endian float64 values of `text`, or null when it is not base64 or its byte length is not `8 x count`. */
export function base64ToFloat64(text: string, count: number): Float64Array | null {
  if (text.length !== Math.ceil((count * 8) / 3) * 4) return null;
  const bytes = base64ToUint8Array(text);
  if (bytes === null || bytes.length !== count * 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float64Array(count);
  for (let i = 0; i < count; i++) values[i] = view.getFloat64(i * 8, true);
  return values;
}
