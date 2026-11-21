/** Typed-array hash tables for vertex clustering (`lod.ts`): no per-entry objects, strings or boxed numbers on a million-triangle mesh. */

const GOLDEN = 0x9e3779b1;

/** Dense ids 0, 1, 2, ... handed out to distinct numbers (Map key equality: NaN equals NaN, -0 equals 0) in first-seen order. */
export class NumberIds {
  private keys = new Float64Array(1024);
  private ids = new Int32Array(1024); // id + 1; 0 marks an empty slot
  private shift = 22;
  count = 0;

  private static slotHash(key: number, shift: number): number {
    return Math.imul(((key >>> 0) ^ Math.imul(Math.floor(key / 0x1_0000_0000) >>> 0, 0x85ebca6b)) | 0, GOLDEN) >>> shift;
  }

  /** The id of `key`, allocating the next one when it is new. */
  idOf(key: number): number {
    if ((this.count + 1) * 2 > this.ids.length) this.grow();
    const mask = this.ids.length - 1;
    let slot = NumberIds.slotHash(key, this.shift);
    for (;;) {
      const stored = this.ids[slot] as number;
      if (stored === 0) break;
      const known = this.keys[slot] as number;
      if (known === key || (known !== known && key !== key)) return stored - 1; // NaN equals NaN, as in a Map
      slot = (slot + 1) & mask;
    }
    this.keys[slot] = key;
    this.ids[slot] = ++this.count;
    return this.count - 1;
  }

  private grow(): void {
    const [oldKeys, oldIds] = [this.keys, this.ids];
    this.keys = new Float64Array(oldKeys.length * 2);
    this.ids = new Int32Array(oldIds.length * 2);
    this.shift--;
    const mask = this.ids.length - 1;
    for (let s = 0; s < oldIds.length; s++) {
      const stored = oldIds[s] as number;
      if (stored === 0) continue;
      let slot = NumberIds.slotHash(oldKeys[s] as number, this.shift);
      while ((this.ids[slot] as number) !== 0) slot = (slot + 1) & mask;
      this.keys[slot] = oldKeys[s] as number;
      this.ids[slot] = stored;
    }
  }
}

/** Set of unordered vertex triples (a, b, c are compared as sorted triples). */
export class TripleSet {
  private slots = new Int32Array(1024 * 3);
  private used = new Uint8Array(1024);
  private shift = 22;
  private count = 0;

  /** True when the triple was new (and is now in the set). */
  add(a: number, b: number, c: number): boolean {
    const lo = Math.min(a, b, c);
    const hi = Math.max(a, b, c);
    const mid = a + b + c - lo - hi;
    if ((this.count + 1) * 2 > this.used.length) this.grow();
    const mask = this.used.length - 1;
    let slot = TripleSet.slotHash(lo, mid, hi, this.shift);
    while (this.used[slot] === 1) {
      if (this.slots[slot * 3] === lo && this.slots[slot * 3 + 1] === mid && this.slots[slot * 3 + 2] === hi) return false;
      slot = (slot + 1) & mask;
    }
    this.used[slot] = 1;
    this.slots[slot * 3] = lo;
    this.slots[slot * 3 + 1] = mid;
    this.slots[slot * 3 + 2] = hi;
    this.count++;
    return true;
  }

  private static slotHash(lo: number, mid: number, hi: number, shift: number): number {
    return Math.imul(Math.imul(lo, 0x9e3779b1) ^ Math.imul(mid, 0x85ebca77) ^ Math.imul(hi, 0xc2b2ae3d), GOLDEN) >>> shift;
  }

  private grow(): void {
    const [oldSlots, oldUsed] = [this.slots, this.used];
    this.slots = new Int32Array(oldSlots.length * 2);
    this.used = new Uint8Array(oldUsed.length * 2);
    this.shift--;
    const mask = this.used.length - 1;
    for (let s = 0; s < oldUsed.length; s++) {
      if (oldUsed[s] === 0) continue;
      const [lo, mid, hi] = [oldSlots[s * 3] as number, oldSlots[s * 3 + 1] as number, oldSlots[s * 3 + 2] as number];
      let slot = TripleSet.slotHash(lo, mid, hi, this.shift);
      while (this.used[slot] === 1) slot = (slot + 1) & mask;
      this.used[slot] = 1;
      this.slots[slot * 3] = lo;
      this.slots[slot * 3 + 1] = mid;
      this.slots[slot * 3 + 2] = hi;
    }
  }
}
