/** Marching squares on a node-sampled field and Douglas-Peucker simplification (TR-TOP-09). Pure. */

import { signedArea } from '@lib/polygon';

export type Point = readonly [number, number];

/** Node samples of a (cols x rows) grid, x fastest. */
export interface NodeGrid {
  readonly cols: number;
  readonly rows: number;
  readonly values: Float64Array;
  /** Node (padding, padding) is node (0, 0) of the sampled field: contour coordinates are shifted back by it. Default 0. */
  readonly padding?: number;
}

/** `grid` surrounded by one ring of zero nodes, so a field that reaches the border still has a closed contour. */
export function padNodeGrid(grid: NodeGrid): NodeGrid {
  const cols = grid.cols + 2;
  const values = new Float64Array(cols * (grid.rows + 2));
  for (let j = 0; j < grid.rows; j += 1)
    for (let i = 0; i < grid.cols; i += 1) values[i + 1 + cols * (j + 1)] = grid.values[i + grid.cols * j] ?? 0;
  return { cols, rows: grid.rows + 2, values, padding: (grid.padding ?? 0) + 1 };
}

/**
 * Node samples of a 2D voxel field: each node is the mean of its (up to four) adjacent voxels, voxels outside the grid count as 0; a ring of
 * zero nodes surrounds them, so every contour closes (also at a threshold <= 0.5 of a field that touches the border).
 */
export function nodeGridOfVoxels(field: ArrayLike<number>, nx: number, ny: number): NodeGrid {
  const values = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j += 1)
    for (let i = 0; i <= nx; i += 1) {
      let sum = 0;
      for (const [di, dj] of [
        [-1, -1],
        [0, -1],
        [-1, 0],
        [0, 0],
      ] as const) {
        const vi = i + di;
        const vj = j + dj;
        if (vi >= 0 && vj >= 0 && vi < nx && vj < ny) sum += field[vi + nx * vj] ?? 0;
      }
      values[i + (nx + 1) * j] = sum / 4;
    }
  return padNodeGrid({ cols: nx + 1, rows: ny + 1, values });
}

type EdgeIndex = 0 | 1 | 2 | 3;
/** Segments (from edge, to edge) per corner case; corners BL, BR, TR, TL = bits 0..3; edges bottom, right, top, left; inside on the left. */
const SEGMENTS: ReadonlyArray<ReadonlyArray<readonly [EdgeIndex, EdgeIndex]>> = [
  [],
  [[0, 3]],
  [[1, 0]],
  [[1, 3]],
  [[2, 1]],
  [], // saddle: resolved by the cell centre
  [[2, 0]],
  [[2, 3]],
  [[3, 2]],
  [[0, 2]],
  [], // saddle: resolved by the cell centre
  [[1, 2]],
  [[3, 1]],
  [[0, 1]],
  [[3, 0]],
  [],
];
const SADDLE_CONNECTED: Readonly<Record<number, ReadonlyArray<readonly [EdgeIndex, EdgeIndex]>>> = {
  5: [
    [0, 1],
    [2, 3],
  ],
  10: [
    [3, 0],
    [1, 2],
  ],
};
const SADDLE_SPLIT: Readonly<Record<number, ReadonlyArray<readonly [EdgeIndex, EdgeIndex]>>> = {
  5: [
    [0, 3],
    [2, 1],
  ],
  10: [
    [1, 0],
    [3, 2],
  ],
};

/**
 * Contour of `grid` at `threshold` as closed loops in node-index coordinates, ordered by their smallest edge key. Inside (value >= threshold) is on
 * the left of each loop, so outer boundaries run counter-clockwise and holes clockwise.
 * @invariant crossings are computed from the lower-index node first, so shared edges give identical points; saddles follow the cell mean
 */
export function marchingSquares(grid: NodeGrid, threshold: number): Point[][] {
  const { cols, rows, values } = grid;
  const shift = grid.padding ?? 0;
  const at = (i: number, j: number): number => values[i + cols * j] ?? 0;
  const edgeKey = (i: number, j: number, edge: EdgeIndex): number => {
    if (edge === 0) return 2 * (i + cols * j);
    if (edge === 1) return 2 * (i + 1 + cols * j) + 1;
    if (edge === 2) return 2 * (i + cols * (j + 1));
    return 2 * (i + cols * j) + 1;
  };
  const next = new Map<number, number>();
  for (let j = 0; j + 1 < rows; j += 1)
    for (let i = 0; i + 1 < cols; i += 1) {
      const corners = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const code = corners.reduce((bits, value, bit) => (value >= threshold ? bits | (1 << bit) : bits), 0);
      const centreInside = corners.reduce((sum, value) => sum + value, 0) / 4 >= threshold;
      const segments = code === 5 || code === 10 ? ((centreInside ? SADDLE_CONNECTED : SADDLE_SPLIT)[code] ?? []) : (SEGMENTS[code] ?? []);
      for (const [from, to] of segments) next.set(edgeKey(i, j, from), edgeKey(i, j, to));
    }
  const point = (key: number): Point => {
    const vertical = key % 2 === 1;
    const node = (key - (vertical ? 1 : 0)) / 2;
    const i = node % cols;
    const j = Math.floor(node / cols);
    const [i2, j2] = vertical ? [i, j + 1] : [i + 1, j];
    const a = at(i, j);
    const b = at(i2, j2);
    const t = b === a ? 0.5 : (threshold - a) / (b - a);
    return [i + (i2 - i) * t - shift, j + (j2 - j) * t - shift];
  };
  const loops: Point[][] = [];
  const visited = new Set<number>();
  for (const start of [...next.keys()].sort((a, b) => a - b)) {
    if (visited.has(start)) continue;
    const loop: Point[] = [];
    let key = start;
    while (!visited.has(key) && next.has(key)) {
      visited.add(key);
      loop.push(point(key));
      key = next.get(key) as number;
    }
    if (loop.length >= 3 && key === start) loops.push(loop);
  }
  return loops;
}

function distanceToChord(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (length * length)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker on the open chain `points[from..to]`: indices of the kept points between the ends (exclusive). */
function simplifyChain(points: readonly Point[], from: number, to: number, tolerance: number, keep: Set<number>): void {
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const distance = distanceToChord(points[i] as Point, points[first] as Point, points[last] as Point);
      if (distance > worstDistance) [worst, worstDistance] = [i, distance];
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([first, worst], [worst, last]);
    }
  }
}

/**
 * Douglas-Peucker simplification of a closed loop: every dropped point lies within `tolerance` of the result.
 * @invariant the loop is split at its first point and the point farthest from it; both chains are simplified; a loop that collapses
 *   below 3 points is returned unsimplified
 */
export function simplifyLoop(loop: readonly Point[], tolerance: number): Point[] {
  if (loop.length <= 3 || !(tolerance > 0)) return [...loop];
  const first = loop[0] as Point;
  let far = 1;
  for (let i = 2; i < loop.length; i += 1)
    if (
      Math.hypot((loop[i] as Point)[0] - first[0], (loop[i] as Point)[1] - first[1]) >
      Math.hypot((loop[far] as Point)[0] - first[0], (loop[far] as Point)[1] - first[1])
    )
      far = i;
  const keep = new Set<number>([0, far]);
  simplifyChain(loop, 0, far, tolerance, keep);
  const closed = [...loop, first];
  simplifyChain(closed, far, closed.length - 1, tolerance, keep);
  const kept = [...keep].sort((a, b) => a - b).map((index) => loop[index] as Point);
  return kept.length >= 3 ? kept : [...loop];
}

export interface Contour {
  readonly points: Point[];
  /** Positive for a counter-clockwise (outer) loop, negative for a hole. */
  readonly area: number;
}

/**
 * Closed loops of the contour of `grid` at `threshold`, scaled by `scale` and shifted by `origin` (document units), simplified with
 * `tolerance`, and without the loops whose absolute area is below `minArea`.
 * @returns the loops in a deterministic order and how many were dropped for their area
 */
export function contourLoops(
  grid: NodeGrid,
  threshold: number,
  placement: { readonly origin: Point; readonly scale: number },
  tolerance: number,
  minArea: number,
): { readonly contours: Contour[]; readonly dropped: number } {
  const contours: Contour[] = [];
  let dropped = 0;
  for (const loop of marchingSquares(grid, threshold)) {
    const placed = loop.map((p): Point => [placement.origin[0] + p[0] * placement.scale, placement.origin[1] + p[1] * placement.scale]);
    const points = simplifyLoop(placed, tolerance);
    const area = signedArea(points as Array<[number, number]>);
    if (Math.abs(area) < minArea) dropped += 1;
    else contours.push({ points, area });
  }
  return { contours, dropped };
}
