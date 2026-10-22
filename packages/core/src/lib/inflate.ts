/** Raw DEFLATE decoder (RFC 1951): the reader side of `deflate.ts`, for ZIP-based formats (3MF). */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
  24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  readonly counts: number[];
  readonly symbols: number[];
}

function huffman(lengths: readonly number[]): Huffman {
  const counts = new Array<number>(16).fill(0);
  for (const length of lengths) counts[length] = (counts[length] as number) + 1;
  const offsets = new Array<number>(16).fill(0);
  for (let i = 2; i < 16; i++) offsets[i] = (offsets[i - 1] as number) + (counts[i - 1] as number);
  const symbols = new Array<number>(lengths.length).fill(0);
  lengths.forEach((length, symbol) => {
    if (length !== 0) symbols[offsets[length] as number] = symbol;
    if (length !== 0) offsets[length] = (offsets[length] as number) + 1;
  });
  return { counts, symbols };
}

const FIXED_LITERALS = huffman([
  ...new Array<number>(144).fill(8),
  ...new Array<number>(112).fill(9),
  ...new Array<number>(24).fill(7),
  ...new Array<number>(8).fill(8),
]);
const FIXED_DISTANCES = huffman(new Array<number>(32).fill(5));

class Reader {
  private position = 0;
  private bitBuffer = 0;
  private bitCount = 0;
  constructor(readonly source: Uint8Array) {}

  bits(count: number): number {
    while (this.bitCount < count) {
      if (this.position >= this.source.length) throw new Error('unexpected end of deflate data');
      this.bitBuffer |= (this.source[this.position++] as number) << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  alignToByte(): number {
    this.bitBuffer = 0;
    this.bitCount = 0;
    return this.position;
  }

  skip(bytes: number): void {
    this.position += bytes;
  }

  decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length < 16; length++) {
      code |= this.bits(1);
      const count = table.counts[length] as number;
      if (code - count < first) return table.symbols[index + (code - first)] as number;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('invalid huffman code');
  }
}

function dynamicTables(reader: Reader): [Huffman, Huffman] {
  const literalCount = reader.bits(5) + 257;
  const distanceCount = reader.bits(5) + 1;
  const codeLengthCount = reader.bits(4) + 4;
  const codeLengths = new Array<number>(19).fill(0);
  for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i] as number] = reader.bits(3);
  const codeTable = huffman(codeLengths);
  const lengths: number[] = [];
  while (lengths.length < literalCount + distanceCount) {
    const symbol = reader.decode(codeTable);
    if (symbol < 16) lengths.push(symbol);
    else {
      const previous = symbol === 16 ? (lengths[lengths.length - 1] as number) : 0;
      const repeat = symbol === 16 ? 3 + reader.bits(2) : symbol === 17 ? 3 + reader.bits(3) : 11 + reader.bits(7);
      for (let i = 0; i < repeat; i++) lengths.push(previous);
    }
  }
  return [huffman(lengths.slice(0, literalCount)), huffman(lengths.slice(literalCount))];
}

/** Growable output buffer with a hard cap (a hostile stream cannot allocate beyond it). */
class Sink {
  private bytes = new Uint8Array(1 << 12);
  length = 0;
  constructor(private readonly limit: number) {}

  private reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.limit) throw new Error('deflate output exceeds the size limit');
    if (needed <= this.bytes.length) return;
    const grown = new Uint8Array(Math.min(Math.max(needed, this.bytes.length * 2), this.limit));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  push(value: number): void {
    this.reserve(1);
    this.bytes[this.length++] = value;
  }

  append(chunk: Uint8Array): void {
    this.reserve(chunk.length);
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
  }

  copyBack(distance: number, count: number): void {
    this.reserve(count);
    for (let i = 0; i < count; i++, this.length++) this.bytes[this.length] = this.bytes[this.length - distance] as number;
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/**
 * Inflate a raw DEFLATE stream.
 * @failure truncated or corrupt data (bad block type, stored LEN / NLEN mismatch, bad code or symbol, distance before the start), or output
 *   beyond `maxBytes` -> Error
 */
export function inflateRaw(data: Uint8Array, maxBytes = 1 << 30): Uint8Array {
  const reader = new Reader(data);
  const out = new Sink(maxBytes);
  let last = 0;
  while (last === 0) {
    last = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      const start = reader.alignToByte();
      if (start + 4 > data.length) throw new Error('unexpected end of deflate data');
      const length = (data[start] as number) | ((data[start + 1] as number) << 8);
      const complement = (data[start + 2] as number) | ((data[start + 3] as number) << 8);
      if ((length ^ 0xffff) !== complement) throw new Error('corrupt stored block (LEN / NLEN mismatch)');
      if (start + 4 + length > data.length) throw new Error('unexpected end of deflate data');
      out.append(data.subarray(start + 4, start + 4 + length));
      reader.skip(4 + length);
    } else if (type === 1 || type === 2) {
      const [literals, distances] = type === 1 ? [FIXED_LITERALS, FIXED_DISTANCES] : dynamicTables(reader);
      for (;;) {
        const symbol = reader.decode(literals);
        if (symbol < 256) out.push(symbol);
        else if (symbol === 256) break;
        else {
          const lengthIndex = symbol - 257;
          if (lengthIndex >= LENGTH_BASE.length) throw new Error('invalid deflate length symbol');
          const length = (LENGTH_BASE[lengthIndex] as number) + reader.bits(LENGTH_EXTRA[lengthIndex] as number);
          const distanceSymbol = reader.decode(distances);
          if (distanceSymbol >= DIST_BASE.length) throw new Error('invalid deflate distance symbol');
          const distance = (DIST_BASE[distanceSymbol] ?? 1) + reader.bits(DIST_EXTRA[distanceSymbol] as number);
          if (distance > out.length) throw new Error('invalid deflate distance');
          out.copyBack(distance, length);
        }
      }
    } else throw new Error('invalid deflate block');
  }
  return out.result();
}
