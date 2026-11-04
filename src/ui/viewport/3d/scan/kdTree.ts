// Static kd-tree over a tile's points (local float32 positions), built in a Web Worker (kdTree.worker.ts) and queried on the main thread.
// Pure and generic: it knows boxes and points, not cameras. The snap supplies a box test (can the projection of this box reach the
// pointer?) and a point visitor, so a query visits exactly the points the linear scan would accept, in a different order.

/** Points per leaf: below this a linear loop beats another level of indirection. */
const LEAF_SIZE = 24;

export interface KdTree {
  /** Local xyz, permuted so that every node's points are contiguous (a copy: the tile's own buffer is untouched). */
  readonly positions: Float32Array;
  /** Per node: min xyz, max xyz. */
  readonly bounds: Float32Array;
  /** Per node: child node ids, or -1 for a leaf. */
  readonly left: Int32Array;
  readonly right: Int32Array;
  /** Per node: point range [start, end) in `positions` (in points). */
  readonly start: Uint32Array;
  readonly end: Uint32Array;
}

/** Rearranges `order[lo, hi)` so that the element at `nth` is in its sorted place along `axis` (quickselect). */
function select(order: Uint32Array, source: Float32Array, axis: number, lo: number, hi: number, nth: number): void {
  const key = (i: number): number => source[(order[i] ?? 0) * 3 + axis] ?? 0;
  let left = lo;
  let right = hi - 1;
  while (left < right) {
    const pivot = key(left + ((right - left) >> 1));
    let i = left;
    let j = right;
    while (i <= j) {
      while (key(i) < pivot) i++;
      while (key(j) > pivot) j--;
      if (i <= j) {
        const t = order[i] ?? 0;
        order[i] = order[j] ?? 0;
        order[j] = t;
        i++;
        j--;
      }
    }
    if (nth <= j) right = j;
    else if (nth >= i) left = i;
    else return;
  }
}

/** Builds the tree of `positions` (flat xyz). Median split on the widest axis; O(n log n). */
export function buildKdTree(positions: Float32Array): KdTree {
  const count = Math.floor(positions.length / 3);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const bounds: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const build = (lo: number, hi: number): number => {
    const id = left.length;
    left.push(-1);
    right.push(-1);
    start.push(lo);
    end.push(hi);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const o = (order[i] ?? 0) * 3;
      for (let a = 0; a < 3; a++) {
        const v = positions[o + a] ?? 0;
        if (v < (box[a] ?? 0)) box[a] = v;
        if (v > (box[a + 3] ?? 0)) box[a + 3] = v;
      }
    }
    bounds.push(...box);
    if (hi - lo <= LEAF_SIZE) return id;
    let axis = 0;
    for (let a = 1; a < 3; a++) if ((box[a + 3] ?? 0) - (box[a] ?? 0) > (box[axis + 3] ?? 0) - (box[axis] ?? 0)) axis = a;
    const mid = (lo + hi) >> 1;
    select(order, positions, axis, lo, hi, mid);
    left[id] = build(lo, mid);
    right[id] = build(mid, hi);
    return id;
  };
  if (count > 0) build(0, count);
  const permuted = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = (order[i] ?? 0) * 3;
    permuted[3 * i] = positions[o] ?? 0;
    permuted[3 * i + 1] = positions[o + 1] ?? 0;
    permuted[3 * i + 2] = positions[o + 2] ?? 0;
  }
  return {
    positions: permuted,
    bounds: Float32Array.from(bounds),
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    start: Uint32Array.from(start),
    end: Uint32Array.from(end),
  };
}

/** Local-space box test: false means nothing inside the box can be wanted. */
export type BoxTest = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => boolean;

/** Calls `visit` with the document-space position (local + origin) of every point in a node whose box passes `mayContain`. */
export function visitTree(
  tree: KdTree,
  origin: readonly [number, number, number],
  mayContain: BoxTest,
  visit: (x: number, y: number, z: number) => void,
): void {
  if (tree.left.length === 0) return;
  const stack = [0];
  const { bounds, positions } = tree;
  while (stack.length > 0) {
    const id = stack.pop() ?? 0;
    const b = id * 6;
    if (
      !mayContain(
        origin[0] + (bounds[b] ?? 0),
        origin[1] + (bounds[b + 1] ?? 0),
        origin[2] + (bounds[b + 2] ?? 0),
        origin[0] + (bounds[b + 3] ?? 0),
        origin[1] + (bounds[b + 4] ?? 0),
        origin[2] + (bounds[b + 5] ?? 0),
      )
    )
      continue;
    const l = tree.left[id] ?? -1;
    if (l >= 0) {
      stack.push(tree.right[id] ?? -1, l);
      continue;
    }
    for (let i = tree.start[id] ?? 0, stop = tree.end[id] ?? 0; i < stop; i++) {
      visit(origin[0] + (positions[3 * i] ?? 0), origin[1] + (positions[3 * i + 1] ?? 0), origin[2] + (positions[3 * i + 2] ?? 0));
    }
  }
}
