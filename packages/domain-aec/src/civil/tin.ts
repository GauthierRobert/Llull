/**
 * Terrain TIN: triangulated surface from 3D points, spot-elevation queries through a bucket grid,
 * and contour tracing.
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2, Vec3 } from '@core/model/types';
import { pointInPolygon } from '@lib/polygon';
import { delaunay } from './delaunay';

export interface Tin {
  readonly points: readonly Vec3[];
  /** CCW triangles, flat vertex-index triples. */
  readonly triangles: readonly number[];
}

export interface TinOptions {
  readonly boundary?: readonly Vec2[];
  readonly maxEdgeLength?: number;
}

/** Points closer than this in plan are merged (the first one wins). */
const MERGE_TOLERANCE = 1e-6;

function distinctPoints(points: ReadonlyArray<Vec3>): Vec3[] {
  const seen = new Set<string>();
  const result: Vec3[] = [];
  for (const point of points) {
    const key = `${Math.round(point[0] / MERGE_TOLERANCE)},${Math.round(point[1] / MERGE_TOLERANCE)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(point);
  }
  return result;
}

function planLength(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Delaunay TIN of `source`, dropping triangles outside `boundary` or with an over-long edge. */
export function buildTin(source: ReadonlyArray<Vec3>, options: TinOptions = {}): Tin {
  const points = distinctPoints(source);
  const all = delaunay(points.map((point): Vec2 => [point[0], point[1]]));
  const triangles: number[] = [];
  for (let k = 0; k < all.length; k += 3) {
    const a = points[all[k] as number] as Vec3;
    const b = points[all[k + 1] as number] as Vec3;
    const c = points[all[k + 2] as number] as Vec3;
    if (options.maxEdgeLength !== undefined) {
      const longest = Math.max(planLength(a, b), planLength(b, c), planLength(c, a));
      if (longest > options.maxEdgeLength) continue;
    }
    if (options.boundary !== undefined) {
      const centroid: Vec2 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      if (!pointInPolygon(centroid, options.boundary)) continue;
    }
    triangles.push(all[k] as number, all[k + 1] as number, all[k + 2] as number);
  }
  return { points, triangles };
}

export function triangleCount(tin: Tin): number {
  return tin.triangles.length / 3;
}

function corners(tin: Tin, triangle: number): [Vec3, Vec3, Vec3] {
  return [
    tin.points[tin.triangles[triangle * 3] as number] as Vec3,
    tin.points[tin.triangles[triangle * 3 + 1] as number] as Vec3,
    tin.points[tin.triangles[triangle * 3 + 2] as number] as Vec3,
  ];
}

/** Plan area of the TIN (sum of triangle plan areas). */
export function tinPlanArea(tin: Tin): number {
  let area = 0;
  for (let t = 0; t < triangleCount(tin); t++) {
    const [a, b, c] = corners(tin, t);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return area;
}

export interface TinBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Bounds of the vertices used by at least one triangle; null for an empty TIN. */
export function tinBounds(tin: Tin): TinBounds | null {
  if (tin.triangles.length === 0) return null;
  let [minX, minY, minZ] = [Infinity, Infinity, Infinity];
  let [maxX, maxY, maxZ] = [-Infinity, -Infinity, -Infinity];
  for (const index of tin.triangles) {
    const [x, y, z] = tin.points[index] as Vec3;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

interface TinIndex {
  readonly minX: number;
  readonly minY: number;
  readonly cell: number;
  readonly columns: number;
  readonly rows: number;
  readonly buckets: ReadonlyArray<readonly number[]>;
}

const indexCache = new WeakMap<Tin, TinIndex>();

function tinIndex(tin: Tin): TinIndex {
  const cached = indexCache.get(tin);
  if (cached) return cached;
  const bounds = tinBounds(tin);
  const minX = bounds?.min[0] ?? 0;
  const minY = bounds?.min[1] ?? 0;
  const width = (bounds?.max[0] ?? 0) - minX;
  const height = (bounds?.max[1] ?? 0) - minY;
  const count = Math.max(1, triangleCount(tin));
  const cell = Math.max(Math.sqrt((width * height) / count) * 2, 1e-9) || 1;
  const columns = Math.max(1, Math.ceil(width / cell) + 1);
  const rows = Math.max(1, Math.ceil(height / cell) + 1);
  const buckets: number[][] = Array.from({ length: columns * rows }, () => []);
  for (let t = 0; t < triangleCount(tin); t++) {
    const [a, b, c] = corners(tin, t);
    const x0 = Math.floor((Math.min(a[0], b[0], c[0]) - minX) / cell);
    const x1 = Math.floor((Math.max(a[0], b[0], c[0]) - minX) / cell);
    const y0 = Math.floor((Math.min(a[1], b[1], c[1]) - minY) / cell);
    const y1 = Math.floor((Math.max(a[1], b[1], c[1]) - minY) / cell);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) buckets[y * columns + x]?.push(t);
    }
  }
  const index: TinIndex = { minX, minY, cell, columns, rows, buckets };
  indexCache.set(tin, index);
  return index;
}

const BARYCENTRIC_TOLERANCE = 1e-9;

/** Interpolated elevation at plan point `at`; null outside the TIN. */
export function elevationAt(tin: Tin, at: Vec2): number | null {
  const index = tinIndex(tin);
  const column = Math.floor((at[0] - index.minX) / index.cell);
  const row = Math.floor((at[1] - index.minY) / index.cell);
  if (column < 0 || row < 0 || column >= index.columns || row >= index.rows) return null;
  for (const t of index.buckets[row * index.columns + column] ?? []) {
    const [a, b, c] = corners(tin, t);
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (det === 0) continue;
    const l1 = ((b[1] - c[1]) * (at[0] - c[0]) + (c[0] - b[0]) * (at[1] - c[1])) / det;
    const l2 = ((c[1] - a[1]) * (at[0] - c[0]) + (a[0] - c[0]) * (at[1] - c[1])) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -BARYCENTRIC_TOLERANCE || l2 < -BARYCENTRIC_TOLERANCE || l3 < -BARYCENTRIC_TOLERANCE) {
      continue;
    }
    return l1 * a[2] + l2 * b[2] + l3 * c[2];
  }
  return null;
}

/** Steepest slope (rise / run) of the triangle under `at`; null outside the TIN. */
export function slopeAt(tin: Tin, at: Vec2): number | null {
  const step = Math.max(tinIndex(tin).cell * 1e-3, 1e-6);
  const centre = elevationAt(tin, at);
  if (centre === null) return null;
  const east = elevationAt(tin, [at[0] + step, at[1]]) ?? elevationAt(tin, [at[0] - step, at[1]]);
  const north = elevationAt(tin, [at[0], at[1] + step]) ?? elevationAt(tin, [at[0], at[1] - step]);
  const dx = east === null ? 0 : Math.abs(east - centre) / step;
  const dy = north === null ? 0 : Math.abs(north - centre) / step;
  return Math.hypot(dx, dy);
}

/** Contour elevations that are multiples of `interval` within the TIN's elevation range. */
export function contourLevels(tin: Tin, interval: number, limit = 400): number[] {
  const bounds = tinBounds(tin);
  if (bounds === null || !(interval > 0)) return [];
  const first = Math.ceil(bounds.min[2] / interval - 1e-9);
  const last = Math.floor(bounds.max[2] / interval + 1e-9);
  const levels: number[] = [];
  for (let k = first; k <= last && levels.length < limit; k++) levels.push(k * interval);
  return levels;
}

function keyOf(point: Vec2): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
}

/** Plan polylines where the TIN crosses `level` (closed loops have equal first/last points). */
export function traceContour(tin: Tin, level: number): Vec2[][] {
  const segments: Array<[Vec2, Vec2]> = [];
  for (let t = 0; t < triangleCount(tin); t++) {
    const triangle = corners(tin, t).map(
      (point): Vec3 => [point[0], point[1], point[2] === level ? point[2] + 1e-9 : point[2]],
    ) as [Vec3, Vec3, Vec3];
    const crossings: Vec2[] = [];
    for (let k = 0; k < 3; k++) {
      const a = triangle[k] as Vec3;
      const b = triangle[(k + 1) % 3] as Vec3;
      if ((a[2] - level) * (b[2] - level) >= 0) continue;
      const ratio = (level - a[2]) / (b[2] - a[2]);
      crossings.push([a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio]);
    }
    if (crossings.length === 2) segments.push([crossings[0] as Vec2, crossings[1] as Vec2]);
  }
  const byEnd = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    for (const key of [keyOf(a), keyOf(b)]) byEnd.set(key, [...(byEnd.get(key) ?? []), index]);
  });
  const used = new Set<number>();
  const lines: Vec2[][] = [];
  const extend = (line: Vec2[]): void => {
    for (;;) {
      const tail = line[line.length - 1] as Vec2;
      const next = (byEnd.get(keyOf(tail)) ?? []).find((index) => !used.has(index));
      if (next === undefined) return;
      used.add(next);
      const [a, b] = segments[next] as [Vec2, Vec2];
      line.push(keyOf(a) === keyOf(tail) ? b : a);
    }
  };
  segments.forEach(([a, b], index) => {
    if (used.has(index)) return;
    used.add(index);
    const line: Vec2[] = [a, b];
    extend(line);
    line.reverse();
    extend(line);
    lines.push(line);
  });
  return lines;
}

/** Flat `positions` / `indices` mesh of the TIN. */
export function tinMesh(tin: Tin): { positions: number[]; indices: number[] } {
  const used = [...new Set(tin.triangles)];
  const remap = new Map(used.map((index, position) => [index, position]));
  const positions = used.flatMap((index) => [...(tin.points[index] as Vec3)]);
  const indices = tin.triangles.map((index) => remap.get(index) as number);
  return { positions, indices };
}
