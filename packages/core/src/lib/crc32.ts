/** CRC-32 (IEEE 802.3, reflected 0xEDB88320) as used by PNG chunks and ZIP entries. */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Running CRC-32: start from `CRC32_INIT`, feed chunks through `crc32Update`, close with `crc32Final`. */
export const CRC32_INIT = 0xffffffff;

export function crc32Update(state: number, bytes: Uint8Array): number {
  let c = state;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return c;
}

export const crc32Final = (state: number): number => (state ^ 0xffffffff) >>> 0;

export function crc32(bytes: Uint8Array): number {
  return crc32Final(crc32Update(CRC32_INIT, bytes));
}
