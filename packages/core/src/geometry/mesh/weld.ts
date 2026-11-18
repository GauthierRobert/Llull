/** Vertex welding for indexed triangle meshes: vertices closer than a tolerance share one index; output order is first use in a face traversal (canonical, AF-13). */

import type { MeshData } from '../../model/types';
import { tupleExtent } from '../../lib/extent';

export interface WeldedMesh {
  /** Flat xyz of the welded vertices, in first-use order. */
  readonly positions: number[];
  /** Triangle corner indices (3 per triangle), same triangle order as the input; unreferenced input vertices are dropped. */
  readonly triangles: number[];
  /** Input vertices referenced by a triangle minus welded vertices. */
  readonly mergedVertices: number;
  /** Welded vertex of every input vertex (-1: unreferenced by a triangle). */
  readonly remap: Int32Array;
  /** Input vertex whose coordinates each welded vertex has (the first one that reached it). */
  readonly origin: number[];
}

/** Diagonal of the bounding box of flat xyz positions; 0 when empty. */
export function meshDiagonal(positions: ReadonlyArray<number>): number {
  if (positions.length < 3) return 0;
  const { min, max } = tupleExtent(positions, 3);
  return Math.hypot(
    (max[0] as number) - (min[0] as number),
    (max[1] as number) - (min[1] as number),
    (max[2] as number) - (min[2] as number),
  );
}

/** Open-addressing table from a 32-bit key to a chain of welded vertices (a collision only adds candidates, which callers check by distance). */
class VertexBuckets {
  /** Per slot: [key, head vertex + 1]; head 0 marks an empty slot. */
  private slots = new Int32Array(2 * 1024);
  private shift = 22;
  private used = 0;
  /** Per welded vertex: next vertex of its bucket + 1 (0 ends the chain). */
  private chain = new Int32Array(1024);
  /** One bit per hashed key (16 bits per slot): most of the 27 probes of a lookup hit an empty cell and stop here, in cache. */
  private seen = new Uint32Array((1024 * 16) / 32);
  private seenShift = 32 - 14;

  private slotOf(key: number): number {
    const mask = (this.slots.length >> 1) - 1;
    let slot = Math.imul(key, 0x9e3779b1) >>> this.shift;
    while ((this.slots[2 * slot + 1] as number) !== 0 && this.slots[2 * slot] !== key) slot = (slot + 1) & mask;
    return slot;
  }

  /** Head vertex + 1 of the bucket of `key` (0: empty). */
  head(key: number): number {
    const bit = Math.imul(key, 0x85ebca6b) >>> this.seenShift;
    if (((this.seen[bit >>> 5] as number) & (1 << (bit & 31))) === 0) return 0;
    return this.slots[2 * this.slotOf(key) + 1] as number;
  }

  /** Next vertex + 1 after `vertex` in its bucket (0: end). */
  next(vertex: number): number {
    return this.chain[vertex] as number;
  }

  add(key: number, vertex: number): void {
    if (vertex >= this.chain.length) {
      const grown = new Int32Array(this.chain.length * 2);
      grown.set(this.chain);
      this.chain = grown;
    }
    if ((this.used + 1) * 2 > this.slots.length >> 1) this.grow();
    const slot = this.slotOf(key);
    const head = this.slots[2 * slot + 1] as number;
    const bit = Math.imul(key, 0x85ebca6b) >>> this.seenShift;
    this.seen[bit >>> 5] = (this.seen[bit >>> 5] as number) | (1 << (bit & 31));
    if (head === 0) {
      this.slots[2 * slot] = key;
      this.used++;
    }
    this.chain[vertex] = head;
    this.slots[2 * slot + 1] = vertex + 1;
  }

  private grow(): void {
    const old = this.slots;
    this.slots = new Int32Array(old.length * 2);
    this.shift--;
    this.seenShift--;
    this.seen = new Uint32Array((this.slots.length >> 1) >> 1);
    for (let s = 0; s < old.length; s += 2) {
      if ((old[s + 1] as number) === 0) continue;
      const slot = this.slotOf(old[s] as number);
      this.slots[2 * slot] = old[s] as number;
      this.slots[2 * slot + 1] = old[s + 1] as number;
      const bit = Math.imul(old[s] as number, 0x85ebca6b) >>> this.seenShift;
      this.seen[bit >>> 5] = (this.seen[bit >>> 5] as number) | (1 << (bit & 31));
    }
  }
}

/**
 * Input vertices already resolved, found again by their exact coordinates. A later vertex with the same coordinates gets the same weld
 * target: that target was the lowest welded index within tolerance, and every vertex welded since has a higher index.
 */
class ResolvedVertices {
  private table = new Int32Array(1024);
  private shift = 22;
  private used = 0;

  constructor(private readonly positions: ReadonlyArray<number>) {}

  private keyOf(vertex: number): number {
    const p = this.positions;
    return (
      Math.imul(coordinateBits(p[vertex * 3] as number), H1) ^
      Math.imul(coordinateBits(p[vertex * 3 + 1] as number), H2) ^
      Math.imul(coordinateBits(p[vertex * 3 + 2] as number), H3)
    );
  }

  /** Earlier resolved vertex (index) with exactly these coordinates, or -1. */
  find(x: number, y: number, z: number): number {
    const p = this.positions;
    const key = Math.imul(coordinateBits(x), H1) ^ Math.imul(coordinateBits(y), H2) ^ Math.imul(coordinateBits(z), H3);
    const mask = this.table.length - 1;
    for (let slot = Math.imul(key, 0x9e3779b1) >>> this.shift; ; slot = (slot + 1) & mask) {
      const stored = (this.table[slot] as number) - 1;
      if (stored < 0) return -1;
      if (p[stored * 3] === x && p[stored * 3 + 1] === y && p[stored * 3 + 2] === z) return stored;
    }
  }

  add(vertex: number): void {
    if ((this.used + 1) * 2 > this.table.length) this.grow();
    this.insert(vertex);
    this.used++;
  }

  private insert(vertex: number): void {
    const mask = this.table.length - 1;
    let slot = Math.imul(this.keyOf(vertex), 0x9e3779b1) >>> this.shift;
    while ((this.table[slot] as number) !== 0) slot = (slot + 1) & mask;
    this.table[slot] = vertex + 1;
  }

  private grow(): void {
    const old = this.table;
    this.table = new Int32Array(old.length * 2);
    this.shift--;
    for (const stored of old) if (stored !== 0) this.insert(stored - 1);
  }
}

const H1 = 0x9e3779b1;
const H2 = 0x85ebca77;
const H3 = 0xc2b2ae3d;
const bitsOf = new Float64Array(1);
const wordsOf = new Int32Array(bitsOf.buffer);
/** 32-bit fingerprint of a coordinate's bits; + 0 turns -0 into 0, as the exact comparison does. */
const coordinateBits = (value: number): number => {
  bitsOf[0] = value + 0;
  return (wordsOf[0] as number) ^ (wordsOf[1] as number);
};

/**
 * Weld `mesh` (indexed) at `tolerance` (document units, >= 0; 0 merges only bit-identical coordinates). Vertices within `tolerance`
 * of an earlier welded vertex join it (first come wins, so the result is deterministic).
 * @invariant triangle count and order are unchanged; degenerate triangles are kept (analysis reports them)
 */
export function weldMesh(mesh: MeshData, tolerance: number): WeldedMesh {
  const { positions, indices } = mesh;
  const welded: number[] = [];
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const cell = tolerance > 0 ? tolerance : 0;
  const limit = cell * cell;
  // Buckets are keyed by a 32-bit hash of the cell (or of the exact coordinates); a collision only adds candidates, which are checked by distance.
  const buckets = new VertexBuckets();
  const triangles: number[] = new Array<number>(indices.length);
  const origin: number[] = [];
  let referenced = 0;
  const lookupExact = (x: number, y: number, z: number): number => {
    let best = -1;
    const key = Math.imul(coordinateBits(x), H1) ^ Math.imul(coordinateBits(y), H2) ^ Math.imul(coordinateBits(z), H3);
    for (let link = buckets.head(key); link !== 0; link = buckets.next(link - 1)) {
      const candidate = link - 1;
      if (
        welded[candidate * 3] === x &&
        welded[candidate * 3 + 1] === y &&
        welded[candidate * 3 + 2] === z &&
        (best < 0 || candidate < best)
      )
        best = candidate;
    }
    return best;
  };
  const lookupNear = (x: number, y: number, z: number): number => {
    const ci = Math.floor(x / cell);
    const cj = Math.floor(y / cell);
    const ck = Math.floor(z / cell);
    let best = -1;
    for (let di = -1; di <= 1; di++) {
      const hi = Math.imul((ci + di) | 0, H1);
      for (let dj = -1; dj <= 1; dj++) {
        const hij = hi ^ Math.imul((cj + dj) | 0, H2);
        for (let dk = -1; dk <= 1; dk++) {
          for (let link = buckets.head(hij ^ Math.imul((ck + dk) | 0, H3)); link !== 0; link = buckets.next(link - 1)) {
            const candidate = link - 1;
            const dx = (welded[candidate * 3] as number) - x;
            const dy = (welded[candidate * 3 + 1] as number) - y;
            const dz = (welded[candidate * 3 + 2] as number) - z;
            if (dx * dx + dy * dy + dz * dz <= limit && (best < 0 || candidate < best)) best = candidate;
          }
        }
      }
    }
    return best;
  };
  const register = (x: number, y: number, z: number): number => {
    const index = welded.length / 3;
    welded.push(x, y, z);
    const key =
      cell === 0
        ? Math.imul(coordinateBits(x), H1) ^ Math.imul(coordinateBits(y), H2) ^ Math.imul(coordinateBits(z), H3)
        : Math.imul(Math.floor(x / cell) | 0, H1) ^ Math.imul(Math.floor(y / cell) | 0, H2) ^ Math.imul(Math.floor(z / cell) | 0, H3);
    buckets.add(key, index);
    return index;
  };
  const resolved = cell === 0 ? null : new ResolvedVertices(positions);
  let write = 0;
  for (const corner of indices) {
    let mapped = remap[corner] ?? -1;
    if (mapped < 0) {
      referenced++;
      const [x, y, z] = [positions[corner * 3] as number, positions[corner * 3 + 1] as number, positions[corner * 3 + 2] as number];
      const twin = resolved === null ? -1 : resolved.find(x, y, z);
      mapped = twin >= 0 ? (remap[twin] as number) : cell === 0 ? lookupExact(x, y, z) : lookupNear(x, y, z);
      if (twin < 0 && resolved !== null) resolved.add(corner);
      if (mapped < 0) {
        mapped = register(x, y, z);
        origin.push(corner);
      }
      remap[corner] = mapped;
    }
    triangles[write++] = mapped;
  }
  return { positions: welded, triangles, mergedVertices: referenced - welded.length / 3, remap, origin };
}
