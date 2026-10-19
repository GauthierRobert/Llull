/** Member widths of a thresholded section (TR-TOP-09 `widthSamples`): exact Euclidean distance transform, samples on the medial axis. */

import type { Section } from './rebuild';

export interface WidthSample {
  /** Plane-local [x, y] of the sample, document units. */
  readonly at: readonly [number, number];
  /** Local member width (twice the distance to the nearest void), document units. */
  readonly width: number;
}

/** Cap on the samples returned (largest members first). */
export const MAX_WIDTH_SAMPLES = 200;

const FAR = 1e20;

const get = (array: ArrayLike<number>, index: number): number => array[index] ?? 0;

/** Squared distance transform of one line (Felzenszwalb-Huttenlocher lower envelope of parabolas). */
function transformLine(f: Float64Array, n: number): Float64Array {
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const cross = (q: number, p: number): number => (get(f, q) + q * q - (get(f, p) + p * p)) / (2 * q - 2 * p);
  for (let q = 1; q < n; q += 1) {
    let s = cross(q, get(v, k));
    while (s <= get(z, k)) {
      k -= 1;
      s = cross(q, get(v, k));
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (get(z, k + 1) < q) k += 1;
    d[q] = (q - get(v, k)) ** 2 + get(f, get(v, k));
  }
  return d;
}

/** Distance (in nodes) from every node of `inside` (cols x rows) to the nearest node that is not inside; 0 outside. */
export function distanceToVoid(inside: Uint8Array, cols: number, rows: number): Float64Array {
  const grid = Float64Array.from(inside, (flag) => (flag === 1 ? FAR : 0));
  for (let i = 0; i < cols; i += 1) {
    const column = transformLine(Float64Array.from({ length: rows }, (_, j) => get(grid, i + cols * j)), rows);
    for (let j = 0; j < rows; j += 1) grid[i + cols * j] = get(column, j);
  }
  for (let j = 0; j < rows; j += 1) {
    const row = transformLine(grid.slice(cols * j, cols * (j + 1)), cols);
    for (let i = 0; i < cols; i += 1) grid[i + cols * j] = get(row, i);
  }
  return grid.map((squared) => Math.sqrt(squared));
}

type Loop = readonly (readonly [number, number])[];

/** Distance from (x, y) to the nearest segment of the closed loops. */
function distanceToLoops(x: number, y: number, loops: readonly Loop[]): number {
  let best = Infinity;
  for (const loop of loops)
    loop.forEach((from, index) => {
      const to = loop[(index + 1) % loop.length] ?? from;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length2 = dx * dx + dy * dy;
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / length2));
      best = Math.min(best, Math.hypot(x - (from[0] + t * dx), y - (from[1] + t * dy)));
    });
  return best;
}

/**
 * Member widths of the section at `threshold`: medial-axis nodes (local maxima of the exact distance to the void, at least one node from it)
 * thinned so that no sample lies inside the inscribed disc of a wider one; the width of a sample is twice its distance to the exact `contours`
 * (closed loops in the section's plane-local document units).
 * @invariant deterministic; widest first, at most MAX_WIDTH_SAMPLES
 */
export function widthSamples(section: Section, threshold: number, contours: readonly Loop[]): WidthSample[] {
  const { cols, rows, values } = section.nodes;
  const shift = section.nodes.padding ?? 0;
  const inside = Uint8Array.from(values, (value) => (value >= threshold ? 1 : 0));
  const distance = distanceToVoid(inside, cols, rows);
  const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : (distance[i + cols * j] ?? 0));
  const candidates: { i: number; j: number; d: number }[] = [];
  for (let j = 0; j < rows; j += 1)
    for (let i = 0; i < cols; i += 1) {
      const d = at(i, j);
      if (d < 1) continue;
      let ridge = true;
      for (let dj = -1; dj <= 1 && ridge; dj += 1) for (let di = -1; di <= 1; di += 1) if (at(i + di, j + dj) > d) ridge = false;
      if (ridge) candidates.push({ i, j, d });
    }
  candidates.sort((a, b) => b.d - a.d || a.j - b.j || a.i - b.i);
  const kept: typeof candidates = [];
  for (const candidate of candidates) {
    if (kept.length >= MAX_WIDTH_SAMPLES) break;
    if (kept.every((other) => Math.hypot(other.i - candidate.i, other.j - candidate.j) >= Math.max(candidate.d, 2))) kept.push(candidate);
  }
  return kept
    .map(({ i, j }): WidthSample => {
      const x = section.origin[0] + (i - shift) * section.voxel;
      const y = section.origin[1] + (j - shift) * section.voxel;
      return { at: [x, y], width: 2 * distanceToLoops(x, y, contours) };
    })
    .sort((a, b) => b.width - a.width);
}
