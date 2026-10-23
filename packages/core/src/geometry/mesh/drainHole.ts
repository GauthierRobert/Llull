/**
 * Drain-hole tool of a hollowed mesh (07 MSH FR-MSH-15): a closed cylinder centred on the surface point nearest to the requested place, along the
 * outward surface normal there, 3 x the wall thickness long, so one boolean subtract opens the cavity to the outside.
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { normalOf } from './editMesh';
import type { SurfaceIndex } from './surfaceIndex';

const SEGMENTS = 32;

export interface DrainTool {
  readonly mesh: MeshData;
  /** Surface point the hole is centred on. */
  readonly at: Vec3;
  /** Outward surface normal there (unit). */
  readonly normal: Vec3;
  /** Distance from the requested point to the surface. */
  readonly distance: number;
}

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Closed outward-wound cylinder of `radius` around the segment centre +- axis x halfLength. */
function cylinder(centre: Vec3, axis: Vec3, radius: number, halfLength: number): MeshData {
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit([
    helper[1] * axis[2] - helper[2] * axis[1],
    helper[2] * axis[0] - helper[0] * axis[2],
    helper[0] * axis[1] - helper[1] * axis[0],
  ]);
  const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  const positions: number[] = [];
  const at = (angle: number, along: number): Vec3 => [
    centre[0] + radius * (Math.cos(angle) * u[0] + Math.sin(angle) * v[0]) + along * axis[0],
    centre[1] + radius * (Math.cos(angle) * u[1] + Math.sin(angle) * v[1]) + along * axis[1],
    centre[2] + radius * (Math.cos(angle) * u[2] + Math.sin(angle) * v[2]) + along * axis[2],
  ];
  for (let k = 0; k < SEGMENTS; k++) positions.push(...at((2 * Math.PI * k) / SEGMENTS, -halfLength));
  for (let k = 0; k < SEGMENTS; k++) positions.push(...at((2 * Math.PI * k) / SEGMENTS, halfLength));
  positions.push(centre[0] - halfLength * axis[0], centre[1] - halfLength * axis[1], centre[2] - halfLength * axis[2]);
  positions.push(centre[0] + halfLength * axis[0], centre[1] + halfLength * axis[1], centre[2] + halfLength * axis[2]);
  const [bottomCentre, topCentre] = [2 * SEGMENTS, 2 * SEGMENTS + 1];
  const indices: number[] = [];
  for (let k = 0; k < SEGMENTS; k++) {
    const n = (k + 1) % SEGMENTS;
    indices.push(k, n, SEGMENTS + n, k, SEGMENTS + n, SEGMENTS + k);
    indices.push(bottomCentre, n, k);
    indices.push(topCentre, SEGMENTS + k, SEGMENTS + n);
  }
  // (u, v, axis) is right-handed for every axis, so the winding above is outward for every orientation (tested on 40 directions).
  return { positions, indices };
}

/** Drain tool for the surface of the outward-wound `outward` mesh nearest to `near`; null for an empty mesh. */
export function drainTool(outward: MeshData, index: SurfaceIndex, near: Vec3, diameter: number, wall: number): DrainTool | null {
  const hit = index.closest(near);
  if (hit.face < 0) return null;
  const corner = (k: number): Vec3 => {
    const vertex = outward.indices[hit.face * 3 + k] as number;
    return [
      outward.positions[vertex * 3] as number,
      outward.positions[vertex * 3 + 1] as number,
      outward.positions[vertex * 3 + 2] as number,
    ];
  };
  const normal = unit(normalOf(corner(0), corner(1), corner(2)));
  return { mesh: cylinder(hit.point, normal, diameter / 2, 1.5 * wall), at: hit.point, normal, distance: hit.distance };
}
