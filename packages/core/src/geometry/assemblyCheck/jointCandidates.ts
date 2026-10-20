/**
 * Coaxial cylinder candidates of a revolute joint taken from a tessellation (FR-FPR-08 on kernels without exact faces, TECHNICAL_SPEC 5.2
 * step 8). Triangles whose normal is perpendicular to the joint axis and whose corners sit at one distance from it are grouped by distance
 * and orientation (pin = normal away from the axis, bore = towards it); a group that wraps more than half a turn is a cylinder.
 * @invariant approximate: the radius is the area-weighted mean corner distance (corners of a tessellated cylinder lie on the true surface, so
 *   the error is the clustering tolerance), the axial range is exact to the vertices; a faceted fit never reads as exact
 */

import type { MeshData, Vec3 } from '../../model/types';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';

/** A cylindrical surface coaxial with the joint axis. */
export interface Candidate {
  readonly convex: boolean;
  readonly radius: number;
  /** Axial interval along the joint axis, measured from the anchor. */
  readonly range: readonly [number, number];
}

/** Parallelism tolerance of a face normal to the plane normal to the joint axis (degrees). */
export const ANGLE_DEGREES = 0.5;
/** Axis offset tolerance: absolute (mm) plus relative to the radius. */
export const OFFSET_ABSOLUTE_MM = 0.01;
export const OFFSET_RELATIVE = 1e-4;
/** A fitted surface must wrap this much of a turn (radians): a half pipe or a flat patch is not a pin or a bore. */
const MIN_WRAP = Math.PI;

interface Facet {
  readonly convex: boolean;
  readonly radius: number;
  readonly area: number;
  readonly low: number;
  readonly high: number;
  readonly angles: readonly number[];
}

function facetsOf(mesh: MeshData, anchor: Vec3, axis: Vec3, toleranceOf: (radius: number) => number): Facet[] {
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize3(cross3(axis, helper));
  const e2 = cross3(axis, e1);
  const sine = Math.sin((ANGLE_DEGREES * Math.PI) / 180);
  const point = (index: number): Vec3 => [
    mesh.positions[index * 3] ?? 0,
    mesh.positions[index * 3 + 1] ?? 0,
    mesh.positions[index * 3 + 2] ?? 0,
  ];
  const facets: Facet[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => sub3(point(mesh.indices[t + k] ?? 0), anchor));
    const [a, b, c] = corners;
    if (a === undefined || b === undefined || c === undefined) continue;
    const normal = cross3(sub3(b, a), sub3(c, a));
    const doubleArea = len3(normal);
    if (doubleArea <= 1e-300 || Math.abs(dot3(normal, axis)) / doubleArea > sine) continue;
    const along = corners.map((p) => dot3(p, axis));
    const radial = corners.map((p, k) => sub3(p, scale3(axis, along[k] ?? 0)));
    const radii = radial.map(len3);
    const mean = radii.reduce((sum, radius) => sum + radius, 0) / 3;
    if (mean <= 1e-300 || Math.max(...radii) - Math.min(...radii) > toleranceOf(mean)) continue;
    const middle = scale3(
      radial.reduce<Vec3>((sum, r) => [sum[0] + r[0], sum[1] + r[1], sum[2] + r[2]], [0, 0, 0]),
      1 / 3,
    );
    facets.push({
      convex: dot3(normal, middle) > 0,
      radius: mean,
      area: doubleArea / 2,
      low: Math.min(...along),
      high: Math.max(...along),
      angles: radial.map((r) => Math.atan2(dot3(r, e2), dot3(r, e1))),
    });
  }
  return facets;
}

/** Largest empty stretch of the circle left by `angles` (radians). */
function largestGap(angles: readonly number[]): number {
  const sorted = [...angles].sort((p, q) => p - q);
  let gap = 2 * Math.PI - ((sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0));
  for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, (sorted[i] ?? 0) - (sorted[i - 1] ?? 0));
  return gap;
}

/** Cylinders coaxial with the line through `anchor` along `axisDirection` found on `meshes` (world space, document units). */
export function meshCandidates(meshes: readonly MeshData[], anchor: Vec3, axisDirection: Vec3, mmPerUnit: number): Candidate[] {
  const axis = normalize3(axisDirection);
  const toleranceOf = (radius: number): number => OFFSET_ABSOLUTE_MM / mmPerUnit + OFFSET_RELATIVE * radius;
  const found: Candidate[] = [];
  for (const mesh of meshes) {
    const facets = facetsOf(mesh, anchor, axis, toleranceOf);
    for (const convex of [true, false]) {
      const side = facets.filter((facet) => facet.convex === convex).sort((p, q) => p.radius - q.radius);
      let group: Facet[] = [];
      const flush = (): void => {
        if (group.length === 0) return;
        const gap = largestGap(group.flatMap((facet) => facet.angles));
        if (2 * Math.PI - gap >= MIN_WRAP) {
          const area = group.reduce((sum, facet) => sum + facet.area, 0);
          found.push({
            convex,
            radius: group.reduce((sum, facet) => sum + facet.radius * facet.area, 0) / area,
            range: [Math.min(...group.map((facet) => facet.low)), Math.max(...group.map((facet) => facet.high))],
          });
        }
        group = [];
      };
      for (const facet of side) {
        const first = group[0];
        if (first !== undefined && facet.radius - first.radius > toleranceOf(first.radius)) flush();
        group.push(facet);
      }
      flush();
    }
  }
  return found;
}
