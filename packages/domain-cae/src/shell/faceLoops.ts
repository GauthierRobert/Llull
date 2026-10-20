/** Boundary loops of a triangulated planar face: the outline and holes of a face from its tessellation (edges used by one triangle). */

import type { MeshData } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, normalize3, sub3 } from '@lib/vec3';
import { extentOf } from './types';

export interface PlanarLoops {
  readonly outer: readonly Vec3[];
  readonly holes: readonly (readonly Vec3[])[];
}

/** Welding key of a vertex: coordinates rounded to 1e-9 of the face size. */
const keyOf = (point: Vec3, grid: number): string => point.map((value) => Math.round(value / grid)).join(',');

/** Signed area of a loop about `normal`. */
function areaAbout(loop: readonly Vec3[], normal: Vec3): number {
  let sum = 0;
  loop.forEach((a, index) => {
    const b = loop[(index + 1) % loop.length] ?? a;
    sum += dot3(cross3(a, b), normal);
  });
  return sum / 2;
}

/** Drops vertices on a straight line between their neighbours (tessellations split straight edges). */
function withoutCollinear(loop: readonly Vec3[], tolerance: number): Vec3[] {
  return loop.filter((point, index) => {
    const before = loop[(index - 1 + loop.length) % loop.length] ?? point;
    const after = loop[(index + 1) % loop.length] ?? point;
    const span = sub3(after, before);
    const length = Math.hypot(...span);
    return length === 0 || Math.hypot(...cross3(sub3(point, before), span)) / length > tolerance;
  });
}

/**
 * Outer loop (counter-clockwise about `normal`) and holes (clockwise) of a planar face triangulation. Vertices are welded by position.
 * @failure no boundary or an open chain (a non-manifold tessellation) -> null
 */
export function planarLoops(mesh: MeshData, normal: Vec3): PlanarLoops | null {
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3)
    points.push([mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0]);
  if (points.length === 0) return null;
  const extent = extentOf(points);
  const grid = Math.max(extent, 1e-12) * 1e-9;
  const ids = new Map<string, number>();
  const welded: Vec3[] = [];
  const idOf = (index: number): number => {
    const point = points[index] ?? [0, 0, 0];
    const key = keyOf(point, grid);
    let id = ids.get(key);
    if (id === undefined) {
      id = welded.length;
      ids.set(key, id);
      welded.push(point);
    }
    return id;
  };
  const uses = new Map<string, number>();
  const directed: [number, number][] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const corners = [idOf(mesh.indices[t] ?? 0), idOf(mesh.indices[t + 1] ?? 0), idOf(mesh.indices[t + 2] ?? 0)];
    for (let k = 0; k < 3; k++) {
      const a = corners[k] ?? 0;
      const b = corners[(k + 1) % 3] ?? 0;
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
      directed.push([a, b]);
    }
  }
  const next = new Map<number, number>();
  for (const [a, b] of directed) if (uses.get(a < b ? `${a}:${b}` : `${b}:${a}`) === 1) next.set(a, b);
  const loops: Vec3[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Vec3[] = [];
    let at: number | undefined = start;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      loop.push(welded[at] ?? [0, 0, 0]);
      at = next.get(at);
    }
    if (at !== start) return null;
    loops.push(withoutCollinear(loop, grid * 10));
  }
  const unit = normalize3(normal);
  const valid = loops.filter((loop) => loop.length >= 3);
  if (valid.length === 0) return null;
  valid.sort((a, b) => Math.abs(areaAbout(b, unit)) - Math.abs(areaAbout(a, unit)));
  const [outer, ...holes] = valid;
  if (outer === undefined) return null;
  return {
    outer: areaAbout(outer, unit) < 0 ? [...outer].reverse() : outer,
    holes: holes.map((hole) => (areaAbout(hole, unit) > 0 ? [...hole].reverse() : hole)),
  };
}
