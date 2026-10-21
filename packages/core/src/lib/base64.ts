const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Alphabet as ASCII codes ('=' padding is 61). */
const B64_CODES: Uint8Array = new TextEncoder().encode(B64_CHARS);
const PAD = 61;

/** Base64 of `bytes`, encoded into one ASCII byte buffer and decoded once (linear; a 30 MB GLB in well under a second). */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  const out = new Uint8Array(Math.ceil(len / 3) * 4);
  const code = (sextet: number): number => B64_CODES[sextet] ?? PAD;
  let o = 0;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < len ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < len ? (bytes[i + 2] ?? 0) : 0;
    out[o++] = code(b0 >> 2);
    out[o++] = code(((b0 & 0x03) << 4) | (b1 >> 4));
    out[o++] = i + 1 < len ? code(((b1 & 0x0f) << 2) | (b2 >> 6)) : PAD;
    out[o++] = i + 2 < len ? code(b2 & 0x3f) : PAD;
  }
  return new TextDecoder('latin1').decode(out);
}

/** char code → sextet value; -1 for characters outside the alphabet. */
const B64_VALUES: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

/** `text` is not valid base64. */
export function base64ToUint8Array(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const dataLength = text.length - padding;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let triple = 0;
  let out = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = i < dataLength && code < 128 ? (B64_VALUES[code] ?? -1) : i < dataLength ? -1 : 0;
    if (value < 0) return null;
    triple = (triple << 6) | value;
    if (i % 4 === 3) {
      for (const shift of [16, 8, 0]) if (out < bytes.length) bytes[out++] = (triple >> shift) & 0xff;
      triple = 0;
    }
  }
  return bytes;
}

/** UTF-8 text → base64. */
export function textToBase64(text: string): string {
  return uint8ArrayToBase64(new TextEncoder().encode(text));
}

/** base64 → UTF-8 text; null when `encoded` is not base64 or not valid UTF-8. */
export function base64ToText(encoded: string): string | null {
  const bytes = base64ToUint8Array(encoded);
  if (bytes === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
