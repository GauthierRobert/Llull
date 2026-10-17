/**
 * Small DEFLATE compressor (RFC 1951): LZ77 with hash chains and one block of fixed Huffman codes. Pure (no zlib), good on images with flat
 * colours and repeated rows such as renders; the output is a raw deflate stream (wrap it with `zlibWrap` for a zlib stream).
 */

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MAX_CHAIN = 24;
const HASH_SIZE = 1 << 15;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
  24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

class BitWriter {
  private bytes = new Uint8Array(1024);
  private length = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  /** Appends `count` bits of `value`, least significant first. */
  bits(value: number, count: number): void {
    this.bitBuffer |= value << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.byte(this.bitBuffer & 0xff);
      this.bitBuffer >>>= 8;
      this.bitCount -= 8;
    }
  }

  /** Appends a Huffman code (stored most significant bit first). */
  code(code: number, count: number): void {
    let reversed = 0;
    for (let i = 0; i < count; i += 1) reversed |= ((code >>> i) & 1) << (count - 1 - i);
    this.bits(reversed, count);
  }

  private byte(value: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length] = value;
    this.length += 1;
  }

  finish(): Uint8Array {
    if (this.bitCount > 0) this.byte(this.bitBuffer & 0xff);
    this.bitBuffer = 0;
    this.bitCount = 0;
    return this.bytes.slice(0, this.length);
  }
}

/** Fixed literal/length code of symbol 0..287. */
function writeLiteral(out: BitWriter, symbol: number): void {
  if (symbol < 144) out.code(0x30 + symbol, 8);
  else if (symbol < 256) out.code(0x190 + symbol - 144, 9);
  else if (symbol < 280) out.code(symbol - 256, 7);
  else out.code(0xc0 + symbol - 280, 8);
}

function indexOfBase(bases: readonly number[], value: number): number {
  let index = bases.length - 1;
  while (index > 0 && (bases[index] ?? 0) > value) index -= 1;
  return index;
}

function writeMatch(out: BitWriter, length: number, distance: number): void {
  const lengthIndex = indexOfBase(LENGTH_BASE, length);
  writeLiteral(out, 257 + lengthIndex);
  out.bits(length - (LENGTH_BASE[lengthIndex] ?? 0), LENGTH_EXTRA[lengthIndex] ?? 0);
  const distanceIndex = indexOfBase(DIST_BASE, distance);
  out.code(distanceIndex, 5);
  out.bits(distance - (DIST_BASE[distanceIndex] ?? 0), DIST_EXTRA[distanceIndex] ?? 0);
}

const hashAt = (data: Uint8Array, at: number): number =>
  (((data[at] ?? 0) << 10) ^ ((data[at + 1] ?? 0) << 5) ^ (data[at + 2] ?? 0)) & (HASH_SIZE - 1);

/** Raw DEFLATE stream of `data` (one final block, fixed Huffman codes). @pure */
export function deflateRaw(data: Uint8Array): Uint8Array {
  const out = new BitWriter();
  out.bits(1, 1);
  out.bits(1, 2);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const previous = new Int32Array(WINDOW).fill(-1);
  const insert = (at: number): void => {
    if (at + MIN_MATCH > data.length) return;
    const hash = hashAt(data, at);
    previous[at % WINDOW] = head[hash] ?? -1;
    head[hash] = at;
  };
  let at = 0;
  while (at < data.length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (at + MIN_MATCH <= data.length) {
      let candidate = head[hashAt(data, at)] ?? -1;
      const limit = Math.min(MAX_MATCH, data.length - at);
      for (let chain = 0; candidate >= 0 && at - candidate <= WINDOW && chain < MAX_CHAIN; chain += 1) {
        let length = 0;
        while (length < limit && data[candidate + length] === data[at + length]) length += 1;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = at - candidate;
          if (length === limit) break;
        }
        const next = previous[candidate % WINDOW] ?? -1;
        if (next >= candidate) break;
        candidate = next;
      }
    }
    if (bestLength >= MIN_MATCH) {
      writeMatch(out, bestLength, bestDistance);
      for (let k = 0; k < bestLength; k += 1) insert(at + k);
      at += bestLength;
    } else {
      writeLiteral(out, data[at] ?? 0);
      insert(at);
      at += 1;
    }
  }
  writeLiteral(out, 256);
  return out.finish();
}
