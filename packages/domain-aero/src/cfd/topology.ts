/** Watertight / orientation analysis of an indexed triangle surface (TECHNICAL_SPEC §5.1 steps 4-5): edge use counts, signed volume, area. */

import type { Vec3 } from '@core/model/types';
import type { IndexedSurface } from './weld';

export interface EdgeReport {
  /** Undirected edges used by exactly one triangle. */
  readonly openEdges: number;
  /** Open edges whose midpoint is an accepted opening (inlet / outlet body); not counted in `openEdges`. */
  readonly openingEdges: number;
  /** Edges used by more than two triangles. */
  readonly nonManifoldEdges: number;
  /** Edges used twice in the same direction (inconsistent winding). */
  readonly misorientedEdges: number;
  /** Up to `maxPoints` edge midpoints per class, in surface order. */
  readonly openAt: Vec3[];
  readonly nonManifoldAt: Vec3[];
  readonly misorientedAt: Vec3[];
}

interface EdgeUse {
  forward: number;
  backward: number;
  a: number;
  b: number;
}

/** Midpoints reported per defect class. */
export const MAX_REPORTED_POINTS = 20;

const point = (vertices: readonly number[], v: number): Vec3 => [vertices[v * 3] ?? 0, vertices[v * 3 + 1] ?? 0, vertices[v * 3 + 2] ?? 0];

/** @invariant a closed, consistently oriented 2-manifold has all three counts 0 */
export function edgeReport({ vertices, triangles }: IndexedSurface, isOpening: (midpoint: Vec3) => boolean = () => false): EdgeReport {
  const stride = vertices.length / 3 + 1;
  const uses = new Map<number, EdgeUse>();
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const from = triangles[t + k] ?? 0;
      const to = triangles[t + ((k + 1) % 3)] ?? 0;
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      const key = low * stride + high;
      const use = uses.get(key) ?? { forward: 0, backward: 0, a: low, b: high };
      if (from === low) use.forward++;
      else use.backward++;
      uses.set(key, use);
    }
  }
  const open: Vec3[] = [];
  const nonManifold: Vec3[] = [];
  const misoriented: Vec3[] = [];
  const counts = { open: 0, nonManifold: 0, misoriented: 0 };
  let openings = 0;
  for (const use of uses.values()) {
    const total = use.forward + use.backward;
    const target = total === 1 ? 'open' : total > 2 ? 'nonManifold' : use.forward !== 1 ? 'misoriented' : null;
    if (target === null) continue;
    const p = point(vertices, use.a);
    const q = point(vertices, use.b);
    const mid: Vec3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    if (target === 'open' && isOpening(mid)) {
      openings++;
      continue;
    }
    counts[target]++;
    const list = target === 'open' ? open : target === 'nonManifold' ? nonManifold : misoriented;
    if (list.length < MAX_REPORTED_POINTS) list.push(mid);
  }
  return {
    openEdges: counts.open,
    openingEdges: openings,
    nonManifoldEdges: counts.nonManifold,
    misorientedEdges: counts.misoriented,
    openAt: open,
    nonManifoldAt: nonManifold,
    misorientedAt: misoriented,
  };
}

/** Signed volume by the divergence theorem (positive for an outward-oriented closed surface). */
export function signedVolume({ vertices, triangles }: IndexedSurface): number {
  let sum = 0;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = point(vertices, triangles[t] ?? 0);
    const b = point(vertices, triangles[t + 1] ?? 0);
    const c = point(vertices, triangles[t + 2] ?? 0);
    sum += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return sum;
}

export function surfaceArea({ vertices, triangles }: IndexedSurface): number {
  let sum = 0;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = point(vertices, triangles[t] ?? 0);
    const b = point(vertices, triangles[t + 1] ?? 0);
    const c = point(vertices, triangles[t + 2] ?? 0);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    sum += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  }
  return sum;
}

/** The surface with every triangle's winding reversed. */
export const flipped = (surface: IndexedSurface): IndexedSurface => ({
  vertices: surface.vertices,
  triangles: surface.triangles.map((_, i) => {
    const corner = i % 3;
    const base = i - corner;
    return surface.triangles[base + (corner === 0 ? 0 : corner === 1 ? 2 : 1)] ?? 0;
  }),
});

/** Axis-aligned bounds of the welded vertices. */
export function surfaceBounds({ vertices }: IndexedSurface): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v + 2 < vertices.length; v += 3)
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[v + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? Infinity, value);
      max[axis] = Math.max(max[axis] ?? -Infinity, value);
    }
  return { min, max };
}
