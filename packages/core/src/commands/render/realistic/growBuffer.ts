/** Append-only typed buffers for the path-traced scene: no JS array of tens of millions of numbers (V8 caps those near 1.1e8). @pure */

type Typed = Float32Array | Uint32Array;

class Grow<T extends Typed> {
  private data: T;
  length = 0;

  constructor(private readonly make: (size: number) => T) {
    this.data = make(1024);
  }

  /** Room for `count` more values. */
  reserve(count: number): void {
    if (this.length + count <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + count) size *= 2;
    const grown = this.make(size);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  push2(a: number, b: number): void {
    this.reserve(2);
    this.data[this.length] = a;
    this.data[this.length + 1] = b;
    this.length += 2;
  }

  push3(a: number, b: number, c: number): void {
    this.reserve(3);
    this.data[this.length] = a;
    this.data[this.length + 1] = b;
    this.data[this.length + 2] = c;
    this.length += 3;
  }

  push(value: number): void {
    this.reserve(1);
    this.data[this.length] = value;
    this.length += 1;
  }

  /** The values written so far (a view, no copy). */
  view(): T {
    return this.data.subarray(0, this.length) as T;
  }
}

export const growF32 = (): Grow<Float32Array> => new Grow((size) => new Float32Array(size));
export const growU32 = (): Grow<Uint32Array> => new Grow((size) => new Uint32Array(size));
