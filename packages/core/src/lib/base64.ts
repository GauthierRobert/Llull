const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** @pure base64 of `bytes` — no Node Buffer, no DOM (browser-safe for core). */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < len ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < len ? (bytes[i + 2] ?? 0) : 0;
    out.push(B64_CHARS.charAt(b0 >> 2));
    out.push(B64_CHARS.charAt(((b0 & 0x03) << 4) | (b1 >> 4)));
    out.push(i + 1 < len ? B64_CHARS.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : '=');
    out.push(i + 2 < len ? B64_CHARS.charAt(b2 & 0x3f) : '=');
  }
  return out.join('');
}

/** char code → sextet value; -1 for characters outside the alphabet. */
const B64_VALUES: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

/**
 * @pure bytes of standard padded base64 `text` (inverse of `uint8ArrayToBase64`), or null when
 * `text` is not valid base64.
 */
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
