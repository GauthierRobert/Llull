const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** @pure base64 of `bytes` — no Node Buffer, no DOM (browser-safe for core). */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < len ? bytes[i + 1]! : 0;
    const b2 = i + 2 < len ? bytes[i + 2]! : 0;
    out.push(B64_CHARS[b0 >> 2]!);
    out.push(B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]!);
    out.push(i + 1 < len ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)]! : '=');
    out.push(i + 2 < len ? B64_CHARS[b2 & 0x3f]! : '=');
  }
  return out.join('');
}
