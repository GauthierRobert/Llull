/**
 * Static bounding-volume hierarchy over axis-aligned boxes (plant 09 VIS-M7, TR-VIS-23): the reference implementation of the instance
 * queries (frustum, ray, box overlap). Deterministic binned-SAH build into flat typed arrays; queries return ascending box indices.
 * @invariant every query returns exactly the indices a brute-force scan with the same per-box predicate returns (same arithmetic on the
 *   leaf boxes; a node box only prunes, and every predicate is monotone in box containment), in ascending order, without duplicates
 * @invariant boxes are finite; a box with a NaN / infinite coordinate is outside the contract
 */

import type { Vec3 } from '../model/vectors';
import type { FrustumPlane } from './renderPlanCamera';

const LEAF_SIZE = 4;
const BIN_COUNT = 16;

/** Boxes packed `[minX, minY, minZ, maxX, maxY, maxZ]` per box. */
export type PackedBoxes = Float64Array;

export interface InstanceBvh {
  readonly count: number;
  /** Indices of the boxes that have a point inside every plane's half-space (`normal · p + offset >= 0`), ascending. */
  frustumQuery(planes: readonly FrustumPlane[]): number[];
  /** Indices of the boxes the ray `origin + t * direction`, `t >= 0`, touches, ascending. Non-finite or zero direction: none. */
  rayQuery(origin: Vec3, direction: Vec3): number[];
  /** Indices of the boxes that overlap the closed box [min, max] (touching counts), ascending. */
  boxQuery(min: Vec3, max: Vec3): number[];
}

/** Packs `{ min, max }` boxes. */
export function packBoxes(boxes: readonly { readonly min: Vec3; readonly max: Vec3 }[]): PackedBoxes {
  const packed = new Float64Array(boxes.length * 6);
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    if (box === undefined) continue;
    packed.set(box.min, index * 6);
    packed.set(box.max, index * 6 + 3);
  }
  return packed;
}

/** Brute-force predicate of `frustumQuery` for the box at `offset` of `boxes` (the reference arithmetic). */
export function boxInsidePlanes(boxes: PackedBoxes, offset: number, planes: readonly FrustumPlane[]): boolean {
  for (const { normal, offset: planeOffset } of planes) {
    const x = normal[0] >= 0 ? boxes[offset + 3] : boxes[offset];
    const y = normal[1] >= 0 ? boxes[offset + 4] : boxes[offset + 1];
    const z = normal[2] >= 0 ? boxes[offset + 5] : boxes[offset + 2];
    if (!(normal[0] * (x as number) + normal[1] * (y as number) + normal[2] * (z as number) + planeOffset >= 0)) return false;
  }
  return true;
}

/** True when the box lies fully inside every plane (its near corner passes), so all boxes within it pass too. */
function boxFullyInsidePlanes(boxes: PackedBoxes, offset: number, planes: readonly FrustumPlane[]): boolean {
  for (const { normal, offset: planeOffset } of planes) {
    const x = normal[0] >= 0 ? boxes[offset] : boxes[offset + 3];
    const y = normal[1] >= 0 ? boxes[offset + 1] : boxes[offset + 4];
    const z = normal[2] >= 0 ? boxes[offset + 2] : boxes[offset + 5];
    if (!(normal[0] * (x as number) + normal[1] * (y as number) + normal[2] * (z as number) + planeOffset >= 0)) return false;
  }
  return true;
}

/** Brute-force predicate of `rayQuery` (slab test) for the box at `offset` of `boxes`. */
export function rayHitsBox(boxes: PackedBoxes, offset: number, origin: Vec3, direction: Vec3): boolean {
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const low = boxes[offset + axis] as number;
    const high = boxes[offset + 3 + axis] as number;
    const o = origin[axis] as number;
    const d = direction[axis] as number;
    if (d === 0) {
      if (o < low || o > high) return false;
      continue;
    }
    const t1 = (low - o) / d;
    const t2 = (high - o) / d;
    const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
    if (lo > near) near = lo;
    if (hi < far) far = hi;
    if (near > far) return false;
  }
  return true;
}

/** Brute-force predicate of `boxQuery` for the box at `offset` of `boxes`. */
export function boxOverlapsBox(boxes: PackedBoxes, offset: number, min: Vec3, max: Vec3): boolean {
  return (
    (boxes[offset] as number) <= max[0] &&
    (boxes[offset + 3] as number) >= min[0] &&
    (boxes[offset + 1] as number) <= max[1] &&
    (boxes[offset + 4] as number) >= min[1] &&
    (boxes[offset + 2] as number) <= max[2] &&
    (boxes[offset + 5] as number) >= min[2]
  );
}

const area = (dx: number, dy: number, dz: number): number => (dx < 0 ? 0 : dx * dy + dy * dz + dz * dx);

interface BuildScratch {
  readonly binCount: Uint32Array;
  readonly binBox: Float64Array;
  readonly leftArea: Float64Array;
}

/**
 * Splits `order[start, end)` at the lowest binned-SAH cost over the axis with the widest centroid extent (16 bins). Returns the split position (start < position < end), or -1 when
 * every centroid coincides.
 */
function sahSplit(
  boxes: PackedBoxes,
  centroids: Float64Array,
  order: Uint32Array,
  start: number,
  end: number,
  scratch: BuildScratch,
): number {
  const { binCount, binBox, leftArea } = scratch;
  const lowC = [Infinity, Infinity, Infinity];
  const highC = [-Infinity, -Infinity, -Infinity];
  for (let i = start; i < end; i++) {
    const base = (order[i] as number) * 3;
    for (let a = 0; a < 3; a++) {
      const c = centroids[base + a] as number;
      if (c < (lowC[a] as number)) lowC[a] = c;
      if (c > (highC[a] as number)) highC[a] = c;
    }
  }
  let bestCost = Infinity;
  let bestAxis = -1;
  let bestBin = 0;
  const widest = [0, 1, 2].reduce(
    (best, a) => ((highC[a] as number) - (lowC[a] as number) > (highC[best] as number) - (lowC[best] as number) ? a : best),
    0,
  );
  for (const axis of [widest]) {
    // one axis only: three axes built ~1.5x slower for no measurable query gain (09 spec §12.13)
    const low = lowC[axis] as number;
    const extent = (highC[axis] as number) - low;
    if (!(extent > 0)) continue;
    const scale = BIN_COUNT / extent;
    binCount.fill(0);
    for (let b = 0; b < BIN_COUNT; b++) {
      binBox.fill(Infinity, b * 6, b * 6 + 3);
      binBox.fill(-Infinity, b * 6 + 3, b * 6 + 6);
    }
    for (let i = start; i < end; i++) {
      const id = order[i] as number;
      const bin = Math.min(BIN_COUNT - 1, Math.floor(((centroids[id * 3 + axis] as number) - low) * scale));
      binCount[bin] = (binCount[bin] as number) + 1;
      for (let a = 0; a < 3; a++) {
        const lo = boxes[id * 6 + a] as number;
        const hi = boxes[id * 6 + 3 + a] as number;
        if (lo < (binBox[bin * 6 + a] as number)) binBox[bin * 6 + a] = lo;
        if (hi > (binBox[bin * 6 + 3 + a] as number)) binBox[bin * 6 + 3 + a] = hi;
      }
    }
    // sweep left to right: area of bins [0, k] ; then right to left, combining
    let [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let counted = 0;
    for (let b = 0; b < BIN_COUNT - 1; b++) {
      const o = b * 6;
      x0 = Math.min(x0, binBox[o] as number);
      y0 = Math.min(y0, binBox[o + 1] as number);
      z0 = Math.min(z0, binBox[o + 2] as number);
      x1 = Math.max(x1, binBox[o + 3] as number);
      y1 = Math.max(y1, binBox[o + 4] as number);
      z1 = Math.max(z1, binBox[o + 5] as number);
      counted += binCount[b] as number;
      leftArea[b] = counted === 0 ? 0 : area(x1 - x0, y1 - y0, z1 - z0) * counted;
    }
    [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let rightCount = 0;
    for (let b = BIN_COUNT - 1; b > 0; b--) {
      const o = b * 6;
      x0 = Math.min(x0, binBox[o] as number);
      y0 = Math.min(y0, binBox[o + 1] as number);
      z0 = Math.min(z0, binBox[o + 2] as number);
      x1 = Math.max(x1, binBox[o + 3] as number);
      y1 = Math.max(y1, binBox[o + 4] as number);
      z1 = Math.max(z1, binBox[o + 5] as number);
      rightCount += binCount[b] as number;
      const leftCount = end - start - rightCount;
      if (rightCount === 0 || leftCount === 0) continue;
      const cost = (leftArea[b - 1] as number) + area(x1 - x0, y1 - y0, z1 - z0) * rightCount;
      if (cost < bestCost) {
        bestCost = cost;
        bestAxis = axis;
        bestBin = b;
      }
    }
  }
  if (bestAxis < 0) return -1;
  const low = lowC[bestAxis] as number;
  const scale = BIN_COUNT / ((highC[bestAxis] as number) - low);
  let [left, right] = [start, end - 1];
  while (left <= right) {
    const id = order[left] as number;
    if (Math.min(BIN_COUNT - 1, Math.floor(((centroids[id * 3 + bestAxis] as number) - low) * scale)) < bestBin) left++;
    else {
      order[left] = order[right] as number;
      order[right] = id;
      right--;
    }
  }
  return left > start && left < end ? left : -1;
}

/**
 * Builds the BVH of `boxes` (6 numbers per box).
 * @invariant queries equal the brute-force scan with the same predicate, ascending, no duplicates (boxes finite)
 * @invariant deterministic: the same boxes give the same tree; leaves hold <= 4 boxes except identical-centroid runs, which are halved by index
 */
export function buildInstanceBvh(boxes: PackedBoxes): InstanceBvh {
  const count = Math.floor(boxes.length / 6);
  const centroids = new Float64Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++) centroids[i * 3 + a] = ((boxes[i * 6 + a] as number) + (boxes[i * 6 + 3 + a] as number)) * 0.5;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const capacity = Math.max(1, 2 * count);
  const nodeBox = new Float64Array(capacity * 6);
  const nodeStart = new Uint32Array(capacity);
  const nodeEnd = new Uint32Array(capacity);
  /** First child (the second is the next node); -1 for a leaf. */
  const nodeChild = new Int32Array(capacity).fill(-1);
  const scratch: BuildScratch = {
    binCount: new Uint32Array(BIN_COUNT),
    binBox: new Float64Array(BIN_COUNT * 6),
    leftArea: new Float64Array(BIN_COUNT),
  };
  let nodes = 0;
  if (count > 0) {
    nodes = 1;
    nodeStart[0] = 0;
    nodeEnd[0] = count;
    const stack: number[] = [0];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      const [start, end] = [nodeStart[node] as number, nodeEnd[node] as number];
      let [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = start; i < end; i++) {
        const o = (order[i] as number) * 6;
        x0 = Math.min(x0, boxes[o] as number);
        y0 = Math.min(y0, boxes[o + 1] as number);
        z0 = Math.min(z0, boxes[o + 2] as number);
        x1 = Math.max(x1, boxes[o + 3] as number);
        y1 = Math.max(y1, boxes[o + 4] as number);
        z1 = Math.max(z1, boxes[o + 5] as number);
      }
      nodeBox.set([x0, y0, z0, x1, y1, z1], node * 6);
      if (end - start <= LEAF_SIZE) continue;
      let split = sahSplit(boxes, centroids, order, start, end, scratch);
      if (split < 0) split = start + ((end - start) >> 1);
      const child = nodes;
      nodes += 2;
      nodeChild[node] = child;
      nodeStart[child] = start;
      nodeEnd[child] = split;
      nodeStart[child + 1] = split;
      nodeEnd[child + 1] = end;
      stack.push(child + 1, child);
    }
  }

  /** Depth-first walk: `prune(node)` 0 = skip, 1 = test the leaves, 2 = take the whole subtree. */
  return bvhOver({ count, nodeCount: nodes, boxes, order, nodeBox, nodeStart, nodeEnd, nodeChild });
}

/** Query object over flat BVH state (shared by the build and the import). */
function bvhOver(state: BvhState): InstanceBvh {
  const { count, boxes, order, nodeBox, nodeStart, nodeEnd, nodeChild } = state;
  const walk = (prune: (node: number) => 0 | 1 | 2, leafHit: (box: number) => boolean): number[] => {
    if (count === 0) return [];
    let found = new Uint32Array(64);
    let size = 0;
    const push = (id: number): void => {
      if (size === found.length) {
        const grown = new Uint32Array(found.length * 2);
        grown.set(found);
        found = grown;
      }
      found[size++] = id;
    };
    const stack: number[] = [0];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      const mode = prune(node);
      if (mode === 0) continue;
      if (mode === 2) {
        for (let i = nodeStart[node] as number; i < (nodeEnd[node] as number); i++) push(order[i] as number);
        continue;
      }
      const child = nodeChild[node] as number;
      if (child >= 0) stack.push(child + 1, child);
      else
        for (let i = nodeStart[node] as number; i < (nodeEnd[node] as number); i++) {
          const id = order[i] as number;
          if (leafHit(id)) push(id);
        }
    }
    return Array.from(found.subarray(0, size).sort());
  };

  const bvh: InstanceBvh = {
    count,
    frustumQuery: (planes) =>
      walk(
        (node) => (!boxInsidePlanes(nodeBox, node * 6, planes) ? 0 : boxFullyInsidePlanes(nodeBox, node * 6, planes) ? 2 : 1),
        (id) => boxInsidePlanes(boxes, id * 6, planes),
      ),
    rayQuery: (origin, direction) =>
      !direction.every(Number.isFinite) || !origin.every(Number.isFinite) || direction.every((d) => d === 0)
        ? []
        : walk(
            (node) => (rayHitsBox(nodeBox, node * 6, origin, direction) ? 1 : 0),
            (id) => rayHitsBox(boxes, id * 6, origin, direction),
          ),
    boxQuery: (min, max) =>
      walk(
        (node) => (boxOverlapsBox(nodeBox, node * 6, min, max) ? 1 : 0),
        (id) => boxOverlapsBox(boxes, id * 6, min, max),
      ),
  };
  states.set(bvh, state);
  return bvh;
}

interface BvhState {
  readonly count: number;
  readonly nodeCount: number;
  readonly boxes: PackedBoxes;
  readonly order: Uint32Array;
  readonly nodeBox: Float64Array;
  readonly nodeStart: Uint32Array;
  readonly nodeEnd: Uint32Array;
  readonly nodeChild: Int32Array;
}

const states = new WeakMap<InstanceBvh, BvhState>();

/** Plain, structured-cloneable form of an `InstanceBvh`: typed arrays only, sized exactly (`nodeCount` nodes, `count` boxes). */
export interface InstanceBvhBuffers {
  readonly count: number;
  readonly nodeCount: number;
  /** Input boxes, 6 numbers per box. */
  readonly boxes: Float64Array;
  /** Box indices in leaf order (a permutation of 0..count-1). */
  readonly order: Uint32Array;
  /** Node bounds, 6 numbers per node. */
  readonly nodeBox: Float64Array;
  /** Node range `[nodeStart, nodeEnd)` into `order`. */
  readonly nodeStart: Uint32Array;
  readonly nodeEnd: Uint32Array;
  /** First child (the second is the next node), -1 for a leaf. */
  readonly nodeChild: Int32Array;
  /** The ArrayBuffers to pass as the `transfer` list of `postMessage` (all owned by this object, none shared with the source BVH). */
  readonly transfer: ArrayBuffer[];
}

/**
 * Copies `bvh` into transferable buffers (the source BVH stays usable after a transfer). A BVH not made by `buildInstanceBvh` /
 * `importInstanceBvh` throws.
 */
export function exportInstanceBvh(bvh: InstanceBvh): InstanceBvhBuffers {
  const state = states.get(bvh);
  if (state === undefined) throw new Error('exportInstanceBvh: not an InstanceBvh built by this module');
  const { count, nodeCount } = state;
  const boxes = state.boxes.slice(0, count * 6);
  const order = state.order.slice(0, count);
  const nodeBox = state.nodeBox.slice(0, nodeCount * 6);
  const nodeStart = state.nodeStart.slice(0, nodeCount);
  const nodeEnd = state.nodeEnd.slice(0, nodeCount);
  const nodeChild = state.nodeChild.slice(0, nodeCount);
  const transfer = [boxes, order, nodeBox, nodeStart, nodeEnd, nodeChild].map((array) => array.buffer as ArrayBuffer);
  return { count, nodeCount, boxes, order, nodeBox, nodeStart, nodeEnd, nodeChild, transfer };
}

const fail = (reason: string): never => {
  throw new Error(`importInstanceBvh: ${reason}`);
};

const allFinite = (array: Float64Array): boolean => {
  for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) return false;
  return true;
};

/**
 * Rebuilds an `InstanceBvh` from `exportInstanceBvh` output (any structured-clone / transfer of it). O(count) validation: counts, array
 * types and lengths, finite coordinates, `order` a permutation, node ranges inside `order`, child links in range. Throws `Error` on mismatch.
 * Takes ownership of the arrays (no copy). Queries then equal those of the exported BVH.
 */
export function importInstanceBvh(buffers: InstanceBvhBuffers): InstanceBvh {
  const { count, nodeCount, boxes, order, nodeBox, nodeStart, nodeEnd, nodeChild } = buffers as Partial<InstanceBvhBuffers>;
  if (!Number.isInteger(count) || (count as number) < 0) return fail('count must be a non-negative integer');
  if (!Number.isInteger(nodeCount) || (nodeCount as number) < 0) return fail('nodeCount must be a non-negative integer');
  const [n, nodes] = [count as number, nodeCount as number];
  if (!(boxes instanceof Float64Array) || boxes.length !== n * 6) return fail('boxes must be a Float64Array of 6 * count');
  if (!(order instanceof Uint32Array) || order.length !== n) return fail('order must be a Uint32Array of count');
  if (!(nodeBox instanceof Float64Array) || nodeBox.length !== nodes * 6) return fail('nodeBox must be a Float64Array of 6 * nodeCount');
  if (!(nodeStart instanceof Uint32Array) || nodeStart.length !== nodes) return fail('nodeStart must be a Uint32Array of nodeCount');
  if (!(nodeEnd instanceof Uint32Array) || nodeEnd.length !== nodes) return fail('nodeEnd must be a Uint32Array of nodeCount');
  if (!(nodeChild instanceof Int32Array) || nodeChild.length !== nodes) return fail('nodeChild must be an Int32Array of nodeCount');
  if ((n === 0) !== (nodes === 0) || nodes > 2 * n) return fail('nodeCount inconsistent with count');
  if (!allFinite(boxes) || !allFinite(nodeBox)) return fail('boxes and node bounds must be finite');
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const id = order[i] as number;
    if (id >= n || seen[id] === 1) return fail('order must be a permutation of 0..count-1');
    seen[id] = 1;
  }
  for (let node = 0; node < nodes; node++) {
    const [start, end, child] = [nodeStart[node] as number, nodeEnd[node] as number, nodeChild[node] as number];
    if (start > end || end > n) return fail(`node ${node} range outside order`);
    if (child !== -1 && (child <= node || child + 1 >= nodes)) return fail(`node ${node} child link out of range`);
  }
  return bvhOver({ count: n, nodeCount: nodes, boxes, order, nodeBox, nodeStart, nodeEnd, nodeChild });
}
