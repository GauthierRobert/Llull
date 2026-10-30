/**
 * Streaming raw DEFLATE (RFC 1951) encoder for inputs too large to hold: fixed Huffman codes, LZ77 with one hash candidate over a 32 KiB window,
 * one block per `write`. Pure; memory is the 96 KiB working buffers plus the compressed output. The output inflates with any zlib (`inflateRaw`).
 * @invariant positions are absolute stream offsets in an Int32Array, so the input must stay under `MAX_DEFLATE_INPUT` bytes
 */

export const MAX_DEFLATE_INPUT = 2_000_000_000;

const WINDOW = 32768;
const BLOCK = 1 << 16;
const MAX_MATCH = 258;
const HASH_MASK = (1 << 15) - 1;
const OUT_CHUNK = 1 << 16;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
  24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const reverseBits = (value: number, width: number): number => {
  let out = 0;
  for (let i = 0; i < width; i += 1) out |= ((value >> i) & 1) << (width - 1 - i);
  return out;
};

/** Fixed literal/length code of each symbol 0..287, bit-reversed for the LSB-first stream. */
const LIT_BITS = new Uint8Array(288);
const LIT_CODE = new Uint16Array(288);
for (let symbol = 0; symbol < 288; symbol += 1) {
  const [code, bits] =
    symbol < 144
      ? [0x30 + symbol, 8]
      : symbol < 256
        ? [0x190 + symbol - 144, 9]
        : symbol < 280
          ? [symbol - 256, 7]
          : [0xc0 + symbol - 280, 8];
  LIT_BITS[symbol] = bits as number;
  LIT_CODE[symbol] = reverseBits(code as number, bits as number);
}

const LENGTH_CODE = new Uint8Array(MAX_MATCH + 1);
LENGTH_BASE.forEach((base, code) => {
  const top = base + (1 << (LENGTH_EXTRA[code] as number)) - 1;
  for (let length = base; length <= Math.min(top, MAX_MATCH); length += 1) LENGTH_CODE[length] = code;
});
LENGTH_CODE[MAX_MATCH] = 28;

const DIST_CODE = new Uint8Array(WINDOW + 1);
DIST_BASE.forEach((base, code) => {
  const top = Math.min(base + (1 << (DIST_EXTRA[code] as number)) - 1, WINDOW);
  for (let distance = base; distance <= top; distance += 1) DIST_CODE[distance] = code;
});
const DIST_REVERSED = Array.from({ length: 30 }, (_, code) => reverseBits(code, 5));

export interface DeflateResult {
  readonly chunks: Uint8Array[];
  readonly size: number;
}

export class DeflateStream {
  private readonly chunks: Uint8Array[] = [];

  /** With `onChunk` the compressed bytes are handed over as they are produced and not kept (`finish().chunks` is then empty): a sink that writes them out holds no more than one buffer. */
  constructor(private readonly onChunk?: (chunk: Uint8Array) => void) {}
  private out = new Uint8Array(OUT_CHUNK);
  private outAt = 0;
  private flushed = 0;
  private acc = 0;
  private bitCount = 0;
  private readonly buf = new Uint8Array(WINDOW + BLOCK);
  private bufLen = 0;
  private base = 0;
  private readonly head = new Int32Array(HASH_MASK + 1).fill(-1);

  /** Compressed bytes produced so far. */
  size(): number {
    return this.flushed + this.outAt;
  }

  write(data: Uint8Array): void {
    for (let at = 0; at < data.length; at += BLOCK) this.block(data.subarray(at, at + BLOCK));
  }

  finish(): DeflateResult {
    this.bits(3, 3);
    this.bits(0, 7);
    if (this.bitCount > 0) this.bits(0, 8 - this.bitCount);
    this.emit(this.out.subarray(0, this.outAt));
    this.flushed += this.outAt;
    this.outAt = 0;
    return { chunks: this.chunks, size: this.flushed };
  }

  private emit(chunk: Uint8Array): void {
    if (this.onChunk === undefined) this.chunks.push(chunk);
    else this.onChunk(chunk);
  }

  private bits(value: number, count: number): void {
    this.acc |= value << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.out[this.outAt] = this.acc & 255;
      this.outAt += 1;
      this.acc >>>= 8;
      this.bitCount -= 8;
      if (this.outAt === OUT_CHUNK) {
        this.emit(this.out);
        this.flushed += OUT_CHUNK;
        this.out = new Uint8Array(OUT_CHUNK);
        this.outAt = 0;
      }
    }
  }

  private block(data: Uint8Array): void {
    const { buf, head } = this;
    if (this.bufLen + data.length > buf.length) {
      const keep = Math.min(this.bufLen, WINDOW);
      buf.copyWithin(0, this.bufLen - keep, this.bufLen);
      this.base += this.bufLen - keep;
      this.bufLen = keep;
    }
    const start = this.bufLen;
    buf.set(data, start);
    const end = start + data.length;
    this.bufLen = end;
    this.bits(2, 3);
    let i = start;
    while (i < end) {
      let length = 0;
      let distance = 0;
      if (i + 2 < end) {
        const hash = (((buf[i] as number) << 10) ^ ((buf[i + 1] as number) << 5) ^ (buf[i + 2] as number)) & HASH_MASK;
        const candidate = head[hash] as number;
        head[hash] = this.base + i;
        const j = candidate - this.base;
        if (candidate >= 0 && j >= 0 && i - j <= WINDOW) {
          const limit = Math.min(MAX_MATCH, end - i);
          let l = 0;
          while (l < limit && buf[j + l] === buf[i + l]) l += 1;
          if (l >= 3) {
            length = l;
            distance = i - j;
          }
        }
      }
      if (length === 0) {
        const literal = buf[i] as number;
        this.bits(LIT_CODE[literal] as number, LIT_BITS[literal] as number);
        i += 1;
        continue;
      }
      const lengthCode = LENGTH_CODE[length] as number;
      this.bits(LIT_CODE[257 + lengthCode] as number, LIT_BITS[257 + lengthCode] as number);
      const lengthExtra = LENGTH_EXTRA[lengthCode] as number;
      if (lengthExtra > 0) this.bits(length - (LENGTH_BASE[lengthCode] as number), lengthExtra);
      const distanceCode = DIST_CODE[distance] as number;
      this.bits(DIST_REVERSED[distanceCode] as number, 5);
      const distanceExtra = DIST_EXTRA[distanceCode] as number;
      if (distanceExtra > 0) this.bits(distance - (DIST_BASE[distanceCode] as number), distanceExtra);
      i += length;
    }
    this.bits(0, 7);
  }
}
