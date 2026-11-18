/** SHA-256 (FIPS 180-4) of a string's UTF-8 bytes (or of raw bytes), hex-encoded. Pure; for provenance hashes and file digests. */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const w = new Int32Array(64);

const sigma1 = (e: number): number => ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
const sigma0 = (a: number): number => ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));

/** Compress the 64-byte blocks of `data[start, start + blocks * 64)` into `h` (words kept as signed 32-bit; `| 0` is the mod-2^32 wrap). */
function compress(h: Int32Array, data: Uint8Array, start: number, blocks: number): void {
  let h0 = h[0] as number;
  let h1 = h[1] as number;
  let h2 = h[2] as number;
  let h3 = h[3] as number;
  let h4 = h[4] as number;
  let h5 = h[5] as number;
  let h6 = h[6] as number;
  let h7 = h[7] as number;
  let offset = start;
  for (let block = 0; block < blocks; block += 1, offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const at = offset + t * 4;
      w[t] = ((data[at] as number) << 24) | ((data[at + 1] as number) << 16) | ((data[at + 2] as number) << 8) | (data[at + 3] as number);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h8 = h7;
    // Eight rounds per pass: the working variables rotate by renaming instead of by moving values.
    for (let t = 0; t < 64; t += 8) {
      let t1 = (h8 + sigma1(e) + (g ^ (e & (f ^ g))) + (K[t] as number) + (w[t] as number)) | 0;
      d = (d + t1) | 0;
      h8 = (t1 + sigma0(a) + ((a & b) | (c & (a | b)))) | 0;
      t1 = (g + sigma1(d) + (f ^ (d & (e ^ f))) + (K[t + 1] as number) + (w[t + 1] as number)) | 0;
      c = (c + t1) | 0;
      g = (t1 + sigma0(h8) + ((h8 & a) | (b & (h8 | a)))) | 0;
      t1 = (f + sigma1(c) + (e ^ (c & (d ^ e))) + (K[t + 2] as number) + (w[t + 2] as number)) | 0;
      b = (b + t1) | 0;
      f = (t1 + sigma0(g) + ((g & h8) | (a & (g | h8)))) | 0;
      t1 = (e + sigma1(b) + (d ^ (b & (c ^ d))) + (K[t + 3] as number) + (w[t + 3] as number)) | 0;
      a = (a + t1) | 0;
      e = (t1 + sigma0(f) + ((f & g) | (h8 & (f | g)))) | 0;
      t1 = (d + sigma1(a) + (c ^ (a & (b ^ c))) + (K[t + 4] as number) + (w[t + 4] as number)) | 0;
      h8 = (h8 + t1) | 0;
      d = (t1 + sigma0(e) + ((e & f) | (g & (e | f)))) | 0;
      t1 = (c + sigma1(h8) + (b ^ (h8 & (a ^ b))) + (K[t + 5] as number) + (w[t + 5] as number)) | 0;
      g = (g + t1) | 0;
      c = (t1 + sigma0(d) + ((d & e) | (f & (d | e)))) | 0;
      t1 = (b + sigma1(g) + (a ^ (g & (h8 ^ a))) + (K[t + 6] as number) + (w[t + 6] as number)) | 0;
      f = (f + t1) | 0;
      b = (t1 + sigma0(c) + ((c & d) | (e & (c | d)))) | 0;
      t1 = (a + sigma1(f) + (h8 ^ (f & (g ^ h8))) + (K[t + 7] as number) + (w[t + 7] as number)) | 0;
      e = (e + t1) | 0;
      a = (t1 + sigma0(b) + ((b & c) | (d & (b | c)))) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h8) | 0;
  }
  h[0] = h0;
  h[1] = h1;
  h[2] = h2;
  h[3] = h3;
  h[4] = h4;
  h[5] = h5;
  h[6] = h6;
  h[7] = h7;
}

export function sha256Hex(text: string | Uint8Array): string {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const fullBlocks = bytes.length >>> 6;
  compress(h, bytes, 0, fullBlocks);
  // The remaining 0..63 bytes, the 0x80 marker and the 64-bit big-endian bit length fill one or two final blocks.
  const rest = bytes.length - fullBlocks * 64;
  const tail = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  tail.set(bytes.subarray(fullBlocks * 64));
  tail[rest] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(tail.length - 4, bitLength >>> 0);
  compress(h, tail, 0, tail.length >>> 6);
  return Array.from(h, (word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}
