/**
 * The source-element search of `mapNodalField` on flat arrays (PERF1 §5 row 11): the same bounding-box tree (median split on the widest
 * axis, ties by element index), the same depth-first visiting order (nearer child box first, the left one on a tie), the same pruning and
 * the same tie rule as the recursive search it replaces, so it picks the same element and the same point, bit for bit
 * (`tests/unit/cae/thermomech/mappingEquivalence.test.ts` against the frozen copy). What changed: per-element barycentric terms are computed
 * once, nothing is allocated per visited box, and a candidate that cannot win is not evaluated.
 */

import type { Vec3 } from '@core/model/vectors';

/** Barycentric slack that still counts as inside (a node on a shared face), and the distance below which two candidates tie. */
const INSIDE = 1e-9;
const TIE = 1e-15;

export interface LocatorElement {
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
  readonly low: Vec3;
  readonly high: Vec3;
}

export interface ElementLocator {
  /** Per element: the four corners (12). */
  readonly corners: Float64Array;
  /** Per element: c0 (3), a = c1 - c0, b = c2 - c0, d = c3 - c0, b x d (3 each), det = a . (b x d); NaN det = degenerate. */
  readonly terms: Float64Array;
  /** Per tree node: low (3), high (3). */
  readonly boxes: Float64Array;
  /** Per tree node: element index (leaf) or -1, the lowest element index under it, and the two children (internal nodes). */
  readonly leaf: Int32Array;
  readonly lowest: Int32Array;
  readonly left: Int32Array;
  readonly right: Int32Array;
}

export interface LocatedHit {
  readonly element: number;
  readonly distance: number;
  readonly point: Vec3;
  /** Barycentric coordinates of p when the containment test found it inside (then `point` is p); null for a surface hit. */
  readonly barycentric: readonly [number, number, number, number] | null;
}

const TERMS = 16;

/** `values[index]`, 0 past the end (noUncheckedIndexedAccess; every index here is in range). One helper per array type keeps each monomorphic. */
function f64(values: Float64Array, index: number): number {
  return values[index] ?? 0;
}

function i32(values: Int32Array, index: number): number {
  return values[index] ?? 0;
}

function at(values: readonly number[], index: number): number {
  return values[index] ?? 0;
}
const FACES = [
  [0, 1, 2],
  [0, 3, 1],
  [1, 3, 2],
  [2, 3, 0],
] as const;

function elementTerms(elements: readonly LocatorElement[]): Float64Array {
  const terms = new Float64Array(elements.length * TERMS);
  for (const [index, { corners }] of elements.entries()) {
    const [c0, c1, c2, c3] = corners;
    const a = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]] as const;
    const b = [c2[0] - c0[0], c2[1] - c0[1], c2[2] - c0[2]] as const;
    const d = [c3[0] - c0[0], c3[1] - c0[1], c3[2] - c0[2]] as const;
    const bd = [b[1] * d[2] - b[2] * d[1], b[2] * d[0] - b[0] * d[2], b[0] * d[1] - b[1] * d[0]] as const;
    const det = a[0] * bd[0] + a[1] * bd[1] + a[2] * bd[2];
    terms.set([...c0, ...a, ...b, ...d, ...bd, !Number.isFinite(det) || Math.abs(det) < 1e-300 ? Number.NaN : det], index * TERMS);
  }
  return terms;
}

/**
 * Barycentric coordinates of (x, y, z) in element `e` written into `out` (false for a degenerate element): the operations of the original
 * `sub3` / `cross3` / `dot3` form in the same order.
 */
function barycentricInto(terms: Float64Array, e: number, x: number, y: number, z: number, out: Float64Array): boolean {
  const o = e * TERMS;
  const det = f64(terms, o + 15);
  if (Number.isNaN(det)) return false;
  const ax = f64(terms, o + 3);
  const ay = f64(terms, o + 4);
  const az = f64(terms, o + 5);
  const bx = f64(terms, o + 6);
  const by = f64(terms, o + 7);
  const bz = f64(terms, o + 8);
  const dx = f64(terms, o + 9);
  const dy = f64(terms, o + 10);
  const dz = f64(terms, o + 11);
  const q0 = x - f64(terms, o);
  const q1 = y - f64(terms, o + 1);
  const q2 = z - f64(terms, o + 2);
  const l1 = (q0 * f64(terms, o + 12) + q1 * f64(terms, o + 13) + q2 * f64(terms, o + 14)) / det;
  const l2 = (ax * (q1 * dz - q2 * dy) + ay * (q2 * dx - q0 * dz) + az * (q0 * dy - q1 * dx)) / det;
  const l3 = (ax * (by * q2 - bz * q1) + ay * (bz * q0 - bx * q2) + az * (bx * q1 - by * q0)) / det;
  out[0] = 1 - l1 - l2 - l3;
  out[1] = l1;
  out[2] = l2;
  out[3] = l3;
  return true;
}

const lambda = new Float64Array(4);

/** Barycentric coordinates of (x, y, z) in element `e` (null for a degenerate element). */
export function barycentricAt(terms: Float64Array, e: number, x: number, y: number, z: number): [number, number, number, number] | null {
  if (!barycentricInto(terms, e, x, y, z, lambda)) return null;
  return [f64(lambda, 0), f64(lambda, 1), f64(lambda, 2), f64(lambda, 3)];
}

interface TreeBuilder {
  readonly boxes: number[];
  readonly leaf: number[];
  readonly lowest: number[];
  readonly left: number[];
  readonly right: number[];
}

function addNode(tree: TreeBuilder, low: Vec3, high: Vec3, element: number, lowest: number): number {
  tree.boxes.push(low[0], low[1], low[2], high[0], high[1], high[2]);
  tree.leaf.push(element);
  tree.lowest.push(lowest);
  tree.left.push(-1);
  tree.right.push(-1);
  return tree.leaf.length - 1;
}

interface SplitInput {
  /** Element boxes: low (3), high (3) per element. */
  readonly bounds: Float64Array;
  /** Box centre of every element on axis 0, then 1, then 2 (`(low + high) / 2`, as the original computed it per node). */
  readonly centres: Float64Array;
  /** True when every centre is a number: (centre, index) is then a strict total order and each axis is sorted once. */
  readonly presorted: boolean;
  readonly mark: Uint8Array;
}

/** `indices` sorted on `axis` by (centre, index): the comparator of the original `build`. */
function sortOn(input: SplitInput, axis: number, indices: Iterable<number>): Int32Array {
  const offset = (axis * input.centres.length) / 3;
  const { centres } = input;
  return Int32Array.from([...indices].sort((a, b) => f64(centres, offset + a) - f64(centres, offset + b) || a - b));
}

/** The members of `list` marked `side`, in list order. */
function partition(list: Int32Array, mark: Uint8Array, side: number, size: number): Int32Array {
  const out = new Int32Array(size);
  let next = 0;
  for (const index of list) if (mark[index] === side) out[next++] = index;
  return out;
}

/**
 * The recursive median split of the original `build`, nodes numbered in creation order. `lists` holds the node's elements sorted on each
 * axis (presorted) or, in the fallback, once in the parent's order (then sorted here, as the original did). A strict total order has one
 * sorted sequence, so splitting the presorted lists gives the same children as sorting each node.
 */
function buildNode(tree: TreeBuilder, input: SplitInput, lists: readonly [Int32Array, Int32Array, Int32Array]): number {
  const { bounds } = input;
  const indices = lists[0];
  const first = i32(indices, 0);
  const o = first * 6;
  if (indices.length === 1)
    return addNode(
      tree,
      [f64(bounds, o), f64(bounds, o + 1), f64(bounds, o + 2)],
      [f64(bounds, o + 3), f64(bounds, o + 4), f64(bounds, o + 5)],
      first,
      first,
    );
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let lowest = first;
  for (const index of indices) {
    if (index < lowest) lowest = index;
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(at(low, axis), f64(bounds, index * 6 + axis));
      high[axis] = Math.max(at(high, axis), f64(bounds, index * 6 + 3 + axis));
    }
  }
  const axis = [0, 1, 2].reduce((best, a) => (at(high, a) - at(low, a) > at(high, best) - at(low, best) ? a : best), 0);
  const sorted = input.presorted ? lists[axis === 0 ? 0 : axis === 1 ? 1 : 2] : sortOn(input, axis, indices);
  const half = sorted.length >> 1;
  const node = addNode(tree, low, high, -1, lowest);
  let leftLists: [Int32Array, Int32Array, Int32Array];
  let rightLists: [Int32Array, Int32Array, Int32Array];
  if (input.presorted) {
    for (const [position, index] of sorted.entries()) input.mark[index] = position < half ? 1 : 0;
    const split = (a: number, side: number, size: number): Int32Array =>
      a === axis
        ? side === 1
          ? sorted.subarray(0, half)
          : sorted.subarray(half)
        : partition(lists[a === 0 ? 0 : a === 1 ? 1 : 2], input.mark, side, size);
    leftLists = [split(0, 1, half), split(1, 1, half), split(2, 1, half)];
    rightLists = [split(0, 0, sorted.length - half), split(1, 0, sorted.length - half), split(2, 0, sorted.length - half)];
  } else {
    const left = sorted.subarray(0, half);
    const right = sorted.subarray(half);
    leftLists = [left, left, left];
    rightLists = [right, right, right];
  }
  const leftChild = buildNode(tree, input, leftLists);
  const rightChild = buildNode(tree, input, rightLists);
  tree.left[node] = leftChild;
  tree.right[node] = rightChild;
  return node;
}

export function buildLocator(elements: readonly LocatorElement[]): ElementLocator {
  const tree: TreeBuilder = { boxes: [], leaf: [], lowest: [], left: [], right: [] };
  const count = elements.length;
  const centres = new Float64Array(3 * count);
  const bounds = new Float64Array(6 * count);
  for (const [index, element] of elements.entries()) {
    bounds.set([...element.low, ...element.high], index * 6);
    for (let axis = 0; axis < 3; axis += 1) centres[axis * count + index] = (at(element.low, axis) + at(element.high, axis)) / 2;
  }
  const input: SplitInput = { bounds, centres, presorted: !centres.some(Number.isNaN), mark: new Uint8Array(count) };
  const all = Int32Array.from(elements.keys());
  buildNode(tree, input, input.presorted ? [sortOn(input, 0, all), sortOn(input, 1, all), sortOn(input, 2, all)] : [all, all, all]);
  const corners = new Float64Array(elements.length * 12);
  for (const [index, element] of elements.entries()) corners.set(element.corners.flat(), index * 12);
  return {
    corners,
    terms: elementTerms(elements),
    boxes: Float64Array.from(tree.boxes),
    leaf: Int32Array.from(tree.leaf),
    lowest: Int32Array.from(tree.lowest),
    left: Int32Array.from(tree.left),
    right: Int32Array.from(tree.right),
  };
}

function boxDistance(boxes: Float64Array, node: number, x: number, y: number, z: number): number {
  const o = node * 6;
  return Math.hypot(
    Math.max(f64(boxes, o) - x, 0, x - f64(boxes, o + 3)),
    Math.max(f64(boxes, o + 1) - y, 0, y - f64(boxes, o + 4)),
    Math.max(f64(boxes, o + 2) - z, 0, z - f64(boxes, o + 5)),
  );
}

/** Scratch of `closestOnTriangle`: the closest point. */
const closest = new Float64Array(3);

function setClosest(x: number, y: number, z: number): void {
  closest[0] = x;
  closest[1] = y;
  closest[2] = z;
}

/**
 * `closestPointOnTriangle` (Ericson 5.1.5) on corner offsets `ia`, `ib`, `ic` of `corners`, written into `closest`: the same operations in
 * the same order (`sub3`, `dot3`, `add3(a, scale3(...))`), so the same bits.
 */
function closestOnTriangle(corners: Float64Array, ia: number, ib: number, ic: number, px: number, py: number, pz: number): void {
  const ax = f64(corners, ia);
  const ay = f64(corners, ia + 1);
  const az = f64(corners, ia + 2);
  const bx = f64(corners, ib);
  const by = f64(corners, ib + 1);
  const bz = f64(corners, ib + 2);
  const cx = f64(corners, ic);
  const cy = f64(corners, ic + 1);
  const cz = f64(corners, ic + 2);
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return setClosest(ax, ay, az);
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return setClosest(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return setClosest(ax + abx * t, ay + aby * t, az + abz * t);
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return setClosest(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return setClosest(ax + acx * t, ay + acy * t, az + acz * t);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return setClosest(bx + (cx - bx) * t, by + (cy - by) * t, bz + (cz - bz) * t);
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return setClosest(ax + (abx * v + acx * w), ay + (aby * v + acy * w), az + (abz * v + acz * w));
}

/** Scratch of `closestOnTet`: the closest point (outside), and whether the last call found p inside. */
const candidate = new Float64Array(3);
let candidateInside = false;
/** Face corner offsets of a tetrahedron (CalculiX face order), times 3. */
const FACE_OFFSETS = FACES.flatMap((face) => face.map((corner) => corner * 3));

/**
 * Distance from p to the closed tetrahedron `e` (the original `closestOnTet`): 0 when p is inside (barycentric slack 1e-9, coordinates left
 * in `lambda`, point p), else the nearest of the four face projections (first face on a tie), its point left in `candidate`.
 */
function closestOnTet(locator: ElementLocator, e: number, px: number, py: number, pz: number): number {
  if (
    barycentricInto(locator.terms, e, px, py, pz, lambda) &&
    f64(lambda, 0) >= -INSIDE &&
    f64(lambda, 1) >= -INSIDE &&
    f64(lambda, 2) >= -INSIDE &&
    f64(lambda, 3) >= -INSIDE
  ) {
    candidateInside = true;
    return 0;
  }
  candidateInside = false;
  const corners = locator.corners;
  const base = e * 12;
  candidate[0] = f64(corners, base);
  candidate[1] = f64(corners, base + 1);
  candidate[2] = f64(corners, base + 2);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let face = 0; face < 12; face += 3) {
    const ia = base + at(FACE_OFFSETS, face);
    const ib = base + at(FACE_OFFSETS, face + 1);
    const ic = base + at(FACE_OFFSETS, face + 2);
    closestOnTriangle(corners, ia, ib, ic, px, py, pz);
    const x = f64(closest, 0);
    const y = f64(closest, 1);
    const z = f64(closest, 2);
    const distance = Math.hypot(px - x, py - y, pz - z);
    if (distance < bestDistance) {
      candidate[0] = x;
      candidate[1] = y;
      candidate[2] = z;
      bestDistance = distance;
    }
  }
  return bestDistance;
}

/**
 * Scratch stack of the depth-first search: node and its box distance, reused between calls. The tree is a median split, so its depth is
 * at most log2(elements) + 1 and the stack holds at most one entry per level plus one: 256 entries cover any mesh that fits in memory.
 */
const stackNodes = new Int32Array(256);
const stackDistances = new Float64Array(256);

function push(depth: number, node: number, distance: number): number {
  stackNodes[depth] = node;
  stackDistances[depth] = distance;
  return depth + 1;
}

/**
 * The lowest-index element containing p (distance 0), else the nearest element (ties within 1e-15: lowest index). Once the best so far is
 * within the tie distance, a box whose elements all have a higher index can never replace it (their distance is >= 0) and is skipped: the
 * search it replaces visited such boxes without effect.
 */
export function locateElement(locator: ElementLocator, p: Vec3): LocatedHit | null {
  const { boxes, leaf, lowest, left, right } = locator;
  const [px, py, pz] = p;
  let bestElement = -1;
  let bestDistance = Number.NaN;
  let bestInside = false;
  const bestPoint = [0, 0, 0];
  const bestLambda = [0, 0, 0, 0];
  let depth = push(0, 0, 0);
  while (depth > 0) {
    depth -= 1;
    const node = i32(stackNodes, depth);
    if (bestElement >= 0 && (f64(stackDistances, depth) > bestDistance + TIE || (bestDistance <= TIE && i32(lowest, node) > bestElement)))
      continue;
    const element = i32(leaf, node);
    if (element >= 0) {
      const distance = closestOnTet(locator, element, px, py, pz);
      if (bestElement < 0 || distance < bestDistance - TIE || (Math.abs(distance - bestDistance) <= TIE && element < bestElement)) {
        bestElement = element;
        bestDistance = distance;
        bestInside = candidateInside;
        const from = bestInside ? lambda : candidate;
        for (let k = 0; k < (bestInside ? 4 : 3); k += 1) (bestInside ? bestLambda : bestPoint)[k] = f64(from, k);
      }
      continue;
    }
    const a = i32(left, node);
    const b = i32(right, node);
    const distanceA = boxDistance(boxes, a, px, py, pz);
    const distanceB = boxDistance(boxes, b, px, py, pz);
    if (distanceB - distanceA < 0) {
      depth = push(depth, a, distanceA);
      depth = push(depth, b, distanceB);
    } else {
      depth = push(depth, b, distanceB);
      depth = push(depth, a, distanceA);
    }
  }
  if (bestElement < 0) return null;
  if (bestInside)
    return {
      element: bestElement,
      distance: 0,
      point: p,
      barycentric: [at(bestLambda, 0), at(bestLambda, 1), at(bestLambda, 2), at(bestLambda, 3)],
    };
  return { element: bestElement, distance: bestDistance, point: [at(bestPoint, 0), at(bestPoint, 1), at(bestPoint, 2)], barycentric: null };
}
