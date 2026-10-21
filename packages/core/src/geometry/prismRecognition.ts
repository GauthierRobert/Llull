/**
 * Recognition of a constant-section prism in a triangle mesh: an axis along which every vertex lies on one of two parallel planes and every
 * side face is parallel to that axis. The result is the section outline (one outer loop, any number of holes) in the frame of an extrusion
 * along the axis, ready to be rebuilt as `extrude_profile` (+ subtracted hole extrusions).
 */

import type { Vec2, Vec3 } from '../model/types';
import { applyMat3, eulerFromMat, matFromAxis, matFromEulerXYZ, type Mat3 } from '../lib/axisRotation';
import { polygonArea, signedArea } from '../lib/polygon';
import { quantizedKey } from '../lib/quantize';
import { cross3, sub3 } from '../lib/vec3';
import { signedMeshVolume } from './meshVolume';
import type { Triangle } from './triangles';

export interface PrismSection {
  /** Extrusion direction (unit) and the Euler rotation of the frame whose +Z it is. */
  readonly axis: Vec3;
  readonly rotation: Vec3;
  /** World position of the start-plane origin (frame origin projected on the axis). */
  readonly position: Vec3;
  readonly depth: number;
  /** Counter-clockwise outer loop and clockwise-agnostic hole loops, in frame XY. */
  readonly outer: Vec2[];
  readonly holes: Vec2[][];
}

export type PrismResult = PrismSection | { readonly reason: string };

const MAX_AXIS_CANDIDATES = 48;
const VOLUME_TOLERANCE = 1e-4;

const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Distinct face normals (up to sign), largest-area first. */
function candidateAxes(tris: readonly Triangle[]): Vec3[] {
  const byKey = new Map<string, { axis: Vec3; area: number }>();
  for (const [a, b, c] of tris) {
    const n = cross3(sub3(b, a), sub3(c, a));
    const length = Math.hypot(n[0], n[1], n[2]);
    if (length < 1e-12) continue;
    let unit: Vec3 = [n[0] / length, n[1] / length, n[2] / length];
    const lead = unit.find((v) => Math.abs(v) > 1e-6) ?? 0;
    if (lead < 0) unit = [-unit[0], -unit[1], -unit[2]];
    const key = quantizedKey(unit, 1e-5);
    const known = byKey.get(key);
    byKey.set(key, { axis: unit, area: (known?.area ?? 0) + length / 2 });
  }
  return [...byKey.values()]
    .sort((x, y) => y.area - x.area)
    .slice(0, MAX_AXIS_CANDIDATES)
    .map((entry) => entry.axis);
}

/** Closed loops of the boundary edges (edges used by one triangle only); null when the boundary is not a set of simple loops. */
function boundaryLoops(tris: readonly Triangle[], key: (p: Vec3) => string): Vec3[][] | null {
  const edges = new Map<string, { a: string; b: string; count: number }>();
  const points = new Map<string, Vec3>();
  for (const tri of tris)
    for (let i = 0; i < 3; i++) {
      const [a, b] = [tri[i] as Vec3, tri[(i + 1) % 3] as Vec3];
      const [ka, kb] = [key(a), key(b)];
      if (ka === kb) continue;
      points.set(ka, a);
      points.set(kb, b);
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const known = edges.get(id);
      edges.set(id, { a: ka, b: kb, count: (known?.count ?? 0) + 1 });
    }
  const adjacency = new Map<string, string[]>();
  for (const { a, b, count } of edges.values()) {
    if (count !== 1) continue;
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  const visited = new Set<string>();
  const loops: Vec3[][] = [];
  for (const [start, neighbours] of adjacency) {
    if (visited.has(start)) continue;
    if (neighbours.length !== 2) return null;
    const loop: Vec3[] = [];
    let current = start;
    let previous = '';
    for (;;) {
      visited.add(current);
      const options = adjacency.get(current) ?? [];
      if (options.length !== 2) return null;
      loop.push(points.get(current) as Vec3);
      const next = options.find((id) => id !== previous) ?? (options[0] as string);
      previous = current;
      current = next;
      if (current === start) break;
      if (visited.has(current)) return null;
    }
    loops.push(loop);
  }
  return loops;
}

/** Drops vertices that lie on the segment between their neighbours. */
function withoutCollinear(points: readonly Vec2[], tolerance: number): Vec2[] {
  let result = [...points];
  for (let changed = true; changed && result.length > 3; ) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const [p, q, r] = [result[(i + result.length - 1) % result.length], result[i], result[(i + 1) % result.length]] as [Vec2, Vec2, Vec2];
      const twiceArea = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
      if (twiceArea <= tolerance * Math.hypot(r[0] - p[0], r[1] - p[1])) {
        result = result.filter((_, index) => index !== i);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function inside(point: Vec2, polygon: readonly Vec2[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = [polygon[i], polygon[j]] as [Vec2, Vec2];
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** The section of `tris` along `axis`, or the reason that axis fails. */
function sectionAlong(tris: readonly Triangle[], axis: Vec3, size: number): PrismResult {
  const matrix = matFromEulerXYZ(eulerFromMat(matFromAxis(axis)));
  const rotation = eulerFromMat(matFromAxis(axis));
  const inverse = transpose(matrix);
  const tolerance = Math.max(1e-9, size * 1e-7);
  const local = tris.map((tri): Triangle => [applyMat3(inverse, tri[0]), applyMat3(inverse, tri[1]), applyMat3(inverse, tri[2])]);
  const zs = local.flatMap((tri) => tri.map((p) => p[2]));
  const [zLow, zHigh] = [Math.min(...zs), Math.max(...zs)];
  const depth = zHigh - zLow;
  if (depth <= tolerance * 10) return { reason: 'flat along that axis' };
  const plane = (z: number): 'low' | 'high' | null =>
    Math.abs(z - zLow) <= tolerance ? 'low' : Math.abs(z - zHigh) <= tolerance ? 'high' : null;
  if (zs.some((z) => plane(z) === null)) return { reason: 'vertices between the two planes' };
  const caps: Triangle[] = [];
  for (const tri of local) {
    const levels = new Set(tri.map((p) => plane(p[2])));
    if (levels.size === 1) {
      if (levels.has('low')) caps.push(tri);
      continue;
    }
    const n = cross3(
      [tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]],
      [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]],
    );
    if (Math.abs(n[2]) > 1e-6 * Math.hypot(n[0], n[1], n[2])) return { reason: 'a side face is not parallel to the axis' };
  }
  if (caps.length === 0) return { reason: 'no cap face on the start plane' };
  const key = (p: Vec3): string => `${Math.round(p[0] / tolerance)},${Math.round(p[1] / tolerance)}`;
  const loops = boundaryLoops(caps, key);
  if (loops === null || loops.length === 0) return { reason: 'the cap outline is not made of simple closed loops' };
  const polygons = loops
    .map((loop) =>
      withoutCollinear(
        loop.map((p): Vec2 => [p[0], p[1]]),
        tolerance,
      ),
    )
    .filter((loop) => loop.length >= 3);
  const ranked = [...polygons].sort((a, b) => polygonArea(b) - polygonArea(a));
  const outerRaw = ranked[0];
  if (outerRaw === undefined) return { reason: 'the cap outline is degenerate' };
  const holes = ranked.slice(1);
  for (const hole of holes) {
    const probe = hole[0] as Vec2;
    if (!inside(probe, outerRaw)) return { reason: 'the section has several separate regions (more than one body)' };
    if (holes.some((other) => other !== hole && inside(probe, other))) return { reason: 'the section has islands inside holes' };
  }
  const outer = signedArea(outerRaw) < 0 ? [...outerRaw].reverse() : outerRaw;
  const expected = (polygonArea(outer) - holes.reduce((sum, hole) => sum + polygonArea(hole), 0)) * depth;
  const volume = Math.abs(
    signedMeshVolume(
      tris.flatMap((tri) => tri.flat()),
      [],
    ),
  );
  if (Math.abs(volume - expected) > VOLUME_TOLERANCE * Math.max(volume, expected))
    return { reason: `the mesh volume ${volume} does not match section area x depth ${expected} (not a closed constant section)` };
  const position = applyMat3(matrix, [0, 0, zLow]);
  return { axis, rotation, position, depth, outer, holes };
}

/**
 * The constant section of `tris` along some axis, or why there is none. Candidate axes are the face normals of the mesh, largest area first.
 * @failure fewer than 4 triangles, no axis with all vertices on two planes and side faces parallel to it, several regions, islands -> { reason }
 */
export function recognizePrism(tris: readonly Triangle[]): PrismResult {
  if (tris.length < 4) return { reason: 'a solid needs at least 4 triangles' };
  const points = tris.flatMap((tri) => tri.map((p) => p));
  const extent = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i] as number)) - Math.min(...points.map((p) => p[i] as number)));
  const size = Math.max(...extent);
  if (!(size > 0)) return { reason: 'the mesh has no extent' };
  let lastReason = 'no candidate axis';
  for (const axis of candidateAxes(tris)) {
    const result = sectionAlong(tris, axis, size);
    if (!('reason' in result)) return result;
    lastReason = result.reason;
  }
  return { reason: `no axis gives a constant section (${lastReason})` };
}
