/**
 * Watertight prism meshes: a planar outline (with holes) swept straight between two placements.
 * Used for slabs with openings, steel members, pipes and cladding panels.
 * @layer core/commands/building
 * @pure
 */

import type { MeshData, Vec2, Vec3 } from '../../model/types';
import { triangulatePolygon } from '../../../lib/triangulate';
import { toCounterClockwise } from '../../../lib/polygon';

/**
 * Builds the prism of `outer` minus `holes`. `place(point, side)` maps a local outline point to
 * world space at the start (side 0) or end (side 1) of the sweep; the local frame must be
 * right-handed with the sweep direction as +z so caps and sides face outward.
 * @returns null when the outline cannot be triangulated
 */
export function prismMesh(
  outer: ReadonlyArray<Vec2>,
  holes: ReadonlyArray<ReadonlyArray<Vec2>>,
  place: (point: Vec2, side: 0 | 1) => Vec3,
): MeshData | null {
  const { vertices, triangles, complete } = triangulatePolygon(outer, holes);
  if (!complete) return null;
  const count = vertices.length;
  const positions: number[] = [];
  for (const side of [1, 0] as const) {
    for (const point of vertices) positions.push(...place(point, side));
  }
  const indices: number[] = [];
  for (const [a, b, c] of triangles) indices.push(a, b, c, c + count, b + count, a + count);
  let ringStart = 0;
  for (const ringLength of [outer.length, ...holes.map((hole) => hole.length)]) {
    for (let index = 0; index < ringLength; index++) {
      const current = ringStart + index;
      const next = ringStart + ((index + 1) % ringLength);
      indices.push(current + count, next + count, next, current + count, next, current);
    }
    ringStart += ringLength;
  }
  return { positions, indices };
}

export interface SweepFrame {
  /** Local x axis (section width). */
  readonly u: Vec3;
  /** Local y axis (section depth). */
  readonly v: Vec3;
  /** Unit sweep direction. */
  readonly d: Vec3;
  readonly length: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/**
 * Member frame: the section depth (v) points "up" (+Z projected off the axis) for horizontal and
 * sloped members, and along +X for vertical members; `roll` then rotates the section about the axis.
 * @returns null for a zero-length axis
 */
export function sweepFrame(start: Vec3, end: Vec3, roll = 0): SweepFrame | null {
  const delta: Vec3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  if (length === 0) return null;
  const d = scale(delta, 1 / length);
  const reference: Vec3 = Math.abs(d[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  const up = normalize(add(reference, scale(d, -dot(reference, d))));
  const side = cross(up, d);
  const [cos, sin] = [Math.cos(roll), Math.sin(roll)];
  const u = add(scale(side, cos), scale(up, -sin));
  const v = add(scale(side, sin), scale(up, cos));
  return { u, v, d, length };
}

/** Sweeps an outline (local units scaled by `factor`) from `start` to `end`. */
export function sweepMesh(
  outer: ReadonlyArray<Vec2>,
  holes: ReadonlyArray<ReadonlyArray<Vec2>>,
  start: Vec3,
  end: Vec3,
  roll: number,
  factor: number,
): MeshData | null {
  const frame = sweepFrame(start, end, roll);
  if (!frame) return null;
  const ccwOuter = toCounterClockwise(outer);
  return prismMesh(ccwOuter, holes, ([x, y], side) =>
    add(add(side === 0 ? start : end, scale(frame.u, x * factor)), scale(frame.v, y * factor)),
  );
}
