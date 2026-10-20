/**
 * Closed-form mass properties of the box, cylinder and sphere primitives in their world pose: their display tessellation loses ~1 % / ~4 %
 * of the volume, so these are never integrated from triangles.
 */

import type { Entity, Vec3 } from '../model/types';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { ORIGIN } from '../lib/vec3';
import type { InertiaTensor, MassProperties } from './massProperties';
import { polygonArea } from '../lib/polygon';

/** Rotate a principal (diagonal) inertia [a, b, c] given in the entity's local axes into world axes: I_w = R · diag · Rᵀ. */
function rotatedPrincipalInertia([a, b, c]: Vec3, rotation: Vec3): InertiaTensor {
  const columns = (
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const
  ).map((axis) => applyEulerXYZ(axis, ORIGIN, rotation));
  const element = (i: number, j: number): number =>
    [a, b, c].reduce((sum, principal, k) => sum + principal * (columns[k]?.[i] ?? 0) * (columns[k]?.[j] ?? 0), 0);
  return [element(0, 0), element(1, 1), element(2, 2), element(0, 1), element(0, 2), element(1, 2)];
}

/** Closed-form mass properties of a box / cylinder (local axis Z) / sphere about its centre; null for every other kind. */
export function primitiveMassProperties(e: Entity, density: number): MassProperties | null {
  if (e.kind === 'box') {
    const [w, h, d] = e.size;
    const volume = w * h * d;
    const mass = volume * density;
    const principal: Vec3 = [(mass * (h * h + d * d)) / 12, (mass * (w * w + d * d)) / 12, (mass * (w * w + h * h)) / 12];
    return { mass, volume, centerOfMass: e.position, inertia: rotatedPrincipalInertia(principal, e.rotation) };
  }
  if (e.kind === 'cylinder') {
    const volume = Math.PI * e.radius * e.radius * e.height;
    const mass = volume * density;
    const transverse = (mass * (3 * e.radius * e.radius + e.height * e.height)) / 12;
    const principal: Vec3 = [transverse, transverse, (mass * e.radius * e.radius) / 2];
    return { mass, volume, centerOfMass: e.position, inertia: rotatedPrincipalInertia(principal, e.rotation) };
  }
  if (e.kind === 'sphere') {
    const volume = (4 / 3) * Math.PI * e.radius ** 3;
    const mass = volume * density;
    const moment = (2 / 5) * mass * e.radius * e.radius;
    return { mass, volume, centerOfMass: e.position, inertia: [moment, moment, moment, 0, 0, 0] };
  }
  return null;
}

/**
 * Pappus-Guldin surface: sweep angle x sum of (edge length x mean edge distance to the axis), plus both profile caps when the turn is
 * partial. Null for a profile that crosses the axis or carries exact curves (its polygon is then only a display approximation).
 */
function revolutionArea(e: Extract<Entity, { kind: 'revolution' }>): number | null {
  if (e.curves !== undefined || e.profile.length < 3 || e.profile.some(([x]) => x < 0)) return null;
  const angle = Math.min(e.angle, 2 * Math.PI);
  let lateral = 0;
  e.profile.forEach(([x1, y1], i) => {
    const [x2, y2] = e.profile[(i + 1) % e.profile.length] ?? [x1, y1];
    lateral += Math.hypot(x2 - x1, y2 - y1) * ((x1 + x2) / 2);
  });
  return angle * lateral + (angle < 2 * Math.PI ? 2 * Math.abs(polygonArea(e.profile)) : 0);
}

/** Surface area in closed form (box, cylinder, sphere, cone, torus, revolution); null for every other kind. */
export function primitiveArea(e: Entity): number | null {
  if (e.kind === 'box') return 2 * (e.size[0] * e.size[1] + e.size[0] * e.size[2] + e.size[1] * e.size[2]);
  if (e.kind === 'cylinder') return 2 * Math.PI * e.radius * (e.radius + e.height);
  if (e.kind === 'sphere') return 4 * Math.PI * e.radius * e.radius;
  if (e.kind === 'cone') return Math.PI * e.radius * (e.radius + Math.hypot(e.radius, e.height));
  if (e.kind === 'torus') return 4 * Math.PI * Math.PI * e.ringRadius * e.tubeRadius;
  if (e.kind === 'revolution') return revolutionArea(e);
  return null;
}
