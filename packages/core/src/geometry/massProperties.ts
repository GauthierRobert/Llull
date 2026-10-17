/**
 * Rigid-body mass properties of a closed triangle mesh (uniform density), by the divergence theorem: exact for the polyhedron, so the only
 * error is tessellation. Eberly, "Polyhedral Mass Properties (Revisited)", Geometric Tools 2002.
 */

import type { Vec3 } from '../model/types';
import { ORIGIN } from '../lib/vec3';
import type { Triangle } from './triangles';
import { boundsOfPoints } from './bounds';

/** Inertia tensor components about the centre of mass, world axes: [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] (Ixy = -∫xy dm convention). */
export type InertiaTensor = readonly [number, number, number, number, number, number];

export interface MassProperties {
  /** Mass (density units × length³). */
  readonly mass: number;
  /** Volume (length³); negative input winding is normalised away. */
  readonly volume: number;
  readonly centerOfMass: Vec3;
  /** About the centre of mass. */
  readonly inertia: InertiaTensor;
}

/** The 10 volume integrals ∫1, ∫x, ∫y, ∫z, ∫x², ∫y², ∫z², ∫xy, ∫yz, ∫zx of one oriented triangle's contribution. */
type Integrals = [number, number, number, number, number, number, number, number, number, number];

function subexpressions(w0: number, w1: number, w2: number): [number, number, number, number, number, number] {
  const temp0 = w0 + w1;
  const f1 = temp0 + w2;
  const temp1 = w0 * w0;
  const temp2 = temp1 + w1 * temp0;
  const f2 = temp2 + w2 * f1;
  const f3 = w0 * temp1 + w1 * temp2 + w2 * f2;
  const g0 = f2 + w0 * (f1 + w0);
  const g1 = f2 + w1 * (f1 + w1);
  const g2 = f2 + w2 * (f1 + w2);
  return [f1, f2, f3, g0, g1, g2];
}

function accumulate(sum: Integrals, [p0, p1, p2]: Triangle): void {
  const [x0, y0, z0] = p0;
  const [x1, y1, z1] = p1;
  const [x2, y2, z2] = p2;
  const [a1, b1, c1] = [x1 - x0, y1 - y0, z1 - z0];
  const [a2, b2, c2] = [x2 - x0, y2 - y0, z2 - z0];
  const d0 = b1 * c2 - b2 * c1;
  const d1 = a2 * c1 - a1 * c2;
  const d2 = a1 * b2 - a2 * b1;
  const [f1x, f2x, f3x, g0x, g1x, g2x] = subexpressions(x0, x1, x2);
  const [, f2y, f3y, g0y, g1y, g2y] = subexpressions(y0, y1, y2);
  const [, f2z, f3z, g0z, g1z, g2z] = subexpressions(z0, z1, z2);
  sum[0] += d0 * f1x;
  sum[1] += d0 * f2x;
  sum[2] += d1 * f2y;
  sum[3] += d2 * f2z;
  sum[4] += d0 * f3x;
  sum[5] += d1 * f3y;
  sum[6] += d2 * f3z;
  sum[7] += d0 * (y0 * g0x + y1 * g1x + y2 * g2x);
  sum[8] += d1 * (z0 * g0y + z1 * g1y + z2 * g2y);
  sum[9] += d2 * (x0 * g0z + x1 * g1z + x2 * g2z);
}

/** Raw volume integrals of a closed mesh (outward winding gives a positive ∫1). */
function volumeIntegrals(triangles: readonly Triangle[]): Integrals {
  const sum: Integrals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const triangle of triangles) accumulate(sum, triangle);
  const scale = [1 / 6, 1 / 24, 1 / 24, 1 / 24, 1 / 60, 1 / 60, 1 / 60, 1 / 120, 1 / 120, 1 / 120] as const;
  return sum.map((value, i) => value * (scale[i] ?? 0)) as Integrals;
}

/**
 * Mass properties of a closed triangle mesh of uniform `density`; null for an empty or zero-volume mesh. Inward (clockwise) winding is
 * accepted: integrals are sign-normalised by the volume.
 */
export function meshMassProperties(triangles: readonly Triangle[], density: number): MassProperties | null {
  const frame = partFrameOrigin(triangles);
  const local = frame === ORIGIN ? triangles : triangles.map(([a, b, c]): Triangle => [minus(a, frame), minus(b, frame), minus(c, frame)]);
  const props = localMeshMassProperties(local, density);
  if (props === null || frame === ORIGIN) return props;
  const [cx, cy, cz] = props.centerOfMass;
  return { ...props, centerOfMass: [cx + frame[0], cy + frame[1], cz + frame[2]] };
}

const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * Part-frame origin (TR-KRN-41): the bounding-box centre rounded to 1 length unit. Integrating about it keeps the products of
 * inertia free of the cancellation a part far from the origin would suffer; results are moved back by the caller.
 */
function partFrameOrigin(triangles: readonly Triangle[]): Vec3 {
  if (triangles.length === 0) return ORIGIN;
  const { min, max } = boundsOfPoints(triangles.flat());
  const centre = (axis: 0 | 1 | 2): number => Math.round((min[axis] + max[axis]) / 2);
  const origin: Vec3 = [centre(0) + 0, centre(1) + 0, centre(2) + 0];
  return origin.every((c) => c === 0) || !origin.every(Number.isFinite) ? ORIGIN : origin;
}

function localMeshMassProperties(triangles: readonly Triangle[], density: number): MassProperties | null {
  const [v, x, y, z, xx, yy, zz, xy, yz, zx] = volumeIntegrals(triangles);
  if (!(Math.abs(v) > 1e-15) || !Number.isFinite(v)) return null;
  const sign = Math.sign(v);
  const volume = Math.abs(v);
  const mass = volume * density;
  const centerOfMass: Vec3 = [x / v, y / v, z / v];
  const [cx, cy, cz] = centerOfMass;
  const m = sign * density;
  const ixx = m * (yy + zz) - mass * (cy * cy + cz * cz);
  const iyy = m * (zz + xx) - mass * (cz * cz + cx * cx);
  const izz = m * (xx + yy) - mass * (cx * cx + cy * cy);
  const ixy = -(m * xy - mass * cx * cy);
  const iyz = -(m * yz - mass * cy * cz);
  const ixz = -(m * zx - mass * cz * cx);
  return { mass, volume, centerOfMass, inertia: [ixx, iyy, izz, ixy, ixz, iyz] };
}

/** Parallel-axis shift of `inertia` (about `from`, a mass `mass`) to the point `to`. */
export function shiftInertia(inertia: InertiaTensor, mass: number, from: Vec3, to: Vec3): InertiaTensor {
  const [dx, dy, dz] = [from[0] - to[0], from[1] - to[1], from[2] - to[2]];
  const [ixx, iyy, izz, ixy, ixz, iyz] = inertia;
  return [
    ixx + mass * (dy * dy + dz * dz),
    iyy + mass * (dx * dx + dz * dz),
    izz + mass * (dx * dx + dy * dy),
    ixy - mass * dx * dy,
    ixz - mass * dx * dz,
    iyz - mass * dy * dz,
  ];
}

/** Combined mass properties of several parts (each about its own centre of mass); null for no parts or zero total mass. */
export function combineMassProperties(parts: readonly MassProperties[]): MassProperties | null {
  const mass = parts.reduce((total, part) => total + part.mass, 0);
  if (!(mass > 0)) return null;
  const weighted = (axis: 0 | 1 | 2): number => parts.reduce((s, p) => s + p.mass * p.centerOfMass[axis], 0) / mass;
  const centerOfMass: Vec3 = [weighted(0), weighted(1), weighted(2)];
  const inertia = parts.reduce<InertiaTensor>(
    (total, part) => {
      const shifted = shiftInertia(part.inertia, part.mass, part.centerOfMass, centerOfMass);
      return total.map((value, i) => value + (shifted[i] ?? 0)) as unknown as InertiaTensor;
    },
    [0, 0, 0, 0, 0, 0],
  );
  return { mass, volume: parts.reduce((total, part) => total + part.volume, 0), centerOfMass, inertia };
}
