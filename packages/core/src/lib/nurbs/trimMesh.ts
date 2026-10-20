/**
 * Display meshing of a trimmed sheet in the (u, v) plane: the grid cells wholly inside the trimmed region stay quads, wholly outside ones are
 * dropped, and the cells cut by a trim loop are split into sub-cells whose corners carry the signed distance to the trim curves (positive in the
 * region): marching squares then cuts each sub-cell along the zero crossing, so the mesh edge follows the curve to a fraction of a sub-cell.
 */

import { insideRegion } from './trimRegion';
import type { UvTrimLoop } from './surfaceTypes';

type Uv = readonly [number, number];
type Triangle = readonly [Uv, Uv, Uv];

export interface TrimmedGrid {
  /** Cells `[i, j]` (between us[i..i+1] and vs[j..j+1]) wholly inside the region. */
  readonly full: Array<readonly [number, number]>;
  /** Triangles (in u, v) of the cells cut by a trim loop. */
  readonly triangles: Triangle[];
}

/** Sub-cells per direction of a cut cell. */
const SUBDIVISIONS = 4;

interface Segment {
  readonly a: Uv;
  readonly b: Uv;
}

/** The index range `[first, last]` of grid cells overlapped by the interval `[low, high]` of the sorted sample values. */
function cellRange(values: ReadonlyArray<number>, low: number, high: number): [number, number] {
  const cells = values.length - 1;
  let first = 0;
  while (first < cells - 1 && (values[first + 1] as number) < low) first++;
  let last = first;
  while (last < cells - 1 && (values[last + 1] as number) <= high) last++;
  return [first, last];
}

function distanceToSegment(p: Uv, { a, b }: Segment): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Polygon of the part of a sub-cell with non-negative field values (corners counter-clockwise), edge crossings by linear interpolation. */
function insidePolygon(corners: ReadonlyArray<Uv>, field: ReadonlyArray<number>): Uv[] {
  const polygon: Uv[] = [];
  corners.forEach((corner, i) => {
    const j = (i + 1) % corners.length;
    const [fi, fj] = [field[i] as number, field[j] as number];
    if (fi >= 0) polygon.push(corner);
    if (fi >= 0 !== fj >= 0) {
      const t = fi / (fi - fj);
      const next = corners[j] as Uv;
      polygon.push([corner[0] + t * (next[0] - corner[0]), corner[1] + t * (next[1] - corner[1])]);
    }
  });
  return polygon;
}

/** Fan triangulation of a convex-ish polygon from its centroid (no triangle for a degenerate polygon). */
function fan(polygon: ReadonlyArray<Uv>): Triangle[] {
  if (polygon.length < 3) return [];
  const centre: Uv = [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];
  return polygon.map((p, k) => [centre, p, polygon[(k + 1) % polygon.length] as Uv] as const);
}

/** Classifies the grid `us` x `vs` against the region of `loops` and meshes the cut cells. */
export function trimGrid(loops: ReadonlyArray<UvTrimLoop>, us: ReadonlyArray<number>, vs: ReadonlyArray<number>): TrimmedGrid {
  const [uMin, uMax, vMin, vMax] = [us[0] as number, us[us.length - 1] as number, vs[0] as number, vs[vs.length - 1] as number];
  const reach = Math.max(uMax - uMin, vMax - vMin);
  const onDomainEdge = (a: Uv, b: Uv): boolean => {
    const eps = 1e-12 * reach;
    const same = (x: number, y: number, bound: number): boolean => Math.abs(x - bound) <= eps && Math.abs(y - bound) <= eps;
    return same(a[0], b[0], uMin) || same(a[0], b[0], uMax) || same(a[1], b[1], vMin) || same(a[1], b[1], vMax);
  };
  const cellSegments = new Map<number, Segment[]>();
  for (const loop of loops)
    loop.polygon.forEach((a, k) => {
      const b = loop.polygon[(k + 1) % loop.polygon.length] as Uv;
      if (onDomainEdge(a, b)) return;
      const [iu, iv] = [
        cellRange(us, Math.min(a[0], b[0]), Math.max(a[0], b[0])),
        cellRange(vs, Math.min(a[1], b[1]), Math.max(a[1], b[1])),
      ];
      for (let i = iu[0]; i <= iu[1]; i++)
        for (let j = iv[0]; j <= iv[1]; j++) {
          const key = i * vs.length + j;
          const list = cellSegments.get(key) ?? [];
          list.push({ a, b });
          cellSegments.set(key, list);
        }
    });
  const inside = (p: Uv): boolean => {
    // a point on the boundary of the domain is judged from just inside it
    const nudge = 1e-9 * reach;
    const nudged: Uv = [Math.min(uMax - nudge, Math.max(uMin + nudge, p[0])), Math.min(vMax - nudge, Math.max(vMin + nudge, p[1]))];
    return insideRegion(loops, nudged);
  };
  const full: Array<readonly [number, number]> = [];
  const triangles: Triangle[] = [];
  for (let i = 0; i + 1 < us.length; i++)
    for (let j = 0; j + 1 < vs.length; j++) {
      const [u0, u1, v0, v1] = [us[i] as number, us[i + 1] as number, vs[j] as number, vs[j + 1] as number];
      const own = cellSegments.get(i * vs.length + j);
      if (own === undefined) {
        if (inside([(u0 + u1) / 2, (v0 + v1) / 2])) full.push([i, j]);
        continue;
      }
      const nearby: Segment[] = [];
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++) nearby.push(...(cellSegments.get((i + di) * vs.length + (j + dj)) ?? []));
      const value = (p: Uv): number => {
        const distance = Math.min(...nearby.map((segment) => distanceToSegment(p, segment)));
        return inside(p) ? distance : -distance;
      };
      const grid = Array.from({ length: SUBDIVISIONS + 1 }, (_, a) =>
        Array.from({ length: SUBDIVISIONS + 1 }, (_, b): { uv: Uv; f: number } => {
          const uv: Uv = [u0 + ((u1 - u0) * a) / SUBDIVISIONS, v0 + ((v1 - v0) * b) / SUBDIVISIONS];
          return { uv, f: value(uv) };
        }),
      );
      for (let a = 0; a < SUBDIVISIONS; a++)
        for (let b = 0; b < SUBDIVISIONS; b++) {
          const cell = [grid[a]?.[b], grid[a + 1]?.[b], grid[a + 1]?.[b + 1], grid[a]?.[b + 1]] as Array<{ uv: Uv; f: number }>;
          triangles.push(
            ...fan(
              insidePolygon(
                cell.map((c) => c.uv),
                cell.map((c) => c.f),
              ),
            ),
          );
        }
    }
  return { full, triangles };
}
