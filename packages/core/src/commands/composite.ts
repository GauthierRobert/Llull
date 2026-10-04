/**
 * Composite commands — higher-level operations that encapsulate geometry patterns
 * that would otherwise be re-derived in every agent prompt.
 *
 * @layer core/commands
 */

import type { Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { newEntity } from './newEntity';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { nextId } from '../lib/id';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';
import { withEntity } from './entityOps';
import { noop } from './noop';

/**
 * Unit axis + angle (Rodrigues rotation matrix R) as the Euler XYZ triple [rx, ry, rz] of the
 * three.js convention (M = Rz·Ry·Rx), with the standard gimbal-lock fallback at ry = ±π/2.
 * @pure
 */
function axisAngleToEulerXYZ(axis: Vec3, angle: number): Vec3 {
  const [kx, ky, kz] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;

  const r00 = t * kx * kx + c;
  const r10 = t * ky * kx + s * kz;
  const r20 = t * kz * kx - s * ky;
  const r21 = t * kz * ky + s * kx;
  const r22 = t * kz * kz + c;

  // M[2][0] = -sin(ry); clamp for numerical safety before asin.
  const ry = Math.asin(Math.max(-1, Math.min(1, -r20)));
  if (Math.abs(Math.cos(ry)) < 1e-9) {
    // Gimbal lock: rx = 0 and rz = atan2(-M[0][1], M[1][1]).
    const r01 = t * kx * ky - s * kz;
    const r11 = t * ky * ky + c;
    return [0, ry, Math.atan2(-r01, r11)];
  }
  return [Math.atan2(r21, r22), ry, Math.atan2(r10, r00)];
}

/**
 * Euler XYZ rotation turning a cylinder's local +Z onto the unit vector `dir`
 * (axis = +Z × dir, angle = acos(dir.z); ≈ +Z is identity, ≈ -Z a half turn about +X).
 * @pure
 */
function directionToEulerXYZ(dir: Vec3): Vec3 {
  const plusZ: Vec3 = [0, 0, 1];
  const cosAngle = Math.max(-1, Math.min(1, dot3(plusZ, dir)));
  if (cosAngle > 1 - 1e-9) return [0, 0, 0];
  if (cosAngle < -1 + 1e-9) return [Math.PI, 0, 0];
  return axisAngleToEulerXYZ(normalize3(cross3(plusZ, dir)), Math.acos(cosAngle));
}

/**
 * @command make_tube_between
 * @pure
 * @layer core/commands
 * @affects creates 1 cylinder entity oriented from p1 to p2
 * @invariant radius > 0; ||p2 - p1|| > 1e-9; rotation encodes dir p1→p2 in intrinsic XYZ Euler
 * @failure radius <= 0 or degenerate p1===p2 or non-array inputs → no-op, affected:[]
 */

export const makeTubeBetween = defineCommand({
  name: 'make_tube_between',
  description:
    'Create a cylinder (tube) that spans exactly from world point p1 to world point p2. ' +
    'Automatically computes the orientation so the cylinder axis runs from p1 to p2 in any ' +
    'plane — eliminates the need to manually derive Euler angles. ' +
    'p1 and p2 are [x, y, z] world coordinates. radius is the tube cross-section radius (> 0). ' +
    'The returned entity id is the only affected id. ' +
    'Fails gracefully (no-op) when radius <= 0 or p1 equals p2 (degenerate tube).',
  params: z.object({
    p1: vec3(
      'Start point of the tube in world space [x, y, z]. The cylinder base center is placed here.',
    ),
    p2: vec3(
      'End point of the tube in world space [x, y, z]. The cylinder top center is placed here.',
    ),
    radius: z.number().describe('Cross-section radius of the tube. Must be greater than 0.'),
    color: z
      .string()
      .describe('Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".')
      .optional(),
  }),
  run: (doc, { p1, p2, radius, color = '#6b8f9c' }): CommandResult => {
    const isPoint = (p: unknown): boolean =>
      Array.isArray(p) && p.length >= 3 && p.every((v) => typeof v === 'number' && isFinite(v));
    if (!isPoint(p1)) {
      return noop(doc, 'make_tube_between failed: p1 must be a numeric [x, y, z] array.');
    }
    if (!isPoint(p2)) {
      return noop(doc, 'make_tube_between failed: p2 must be a numeric [x, y, z] array.');
    }
    if (radius <= 0) {
      return noop(doc, `make_tube_between failed: radius must be > 0, got ${radius}.`);
    }

    const delta = sub3(p2, p1);
    const length = Math.sqrt(dot3(delta, delta));
    if (length < 1e-9) {
      return noop(
        doc,
        `make_tube_between failed: p1 and p2 are the same point (distance ${length.toFixed(9)} < 1e-9).`,
      );
    }

    const rotation = directionToEulerXYZ(scale3(delta, 1 / length));
    // Cylinders are centered on their centroid, so the entity sits at the midpoint of p1..p2.
    const mid = scale3(add3(p1, p2), 0.5);

    const id = nextId('cyl');
    const entity = newEntity('cylinder', id, { radius, height: length }, mid, color, {
      rotation: rotation,
    });

    const fmtPoint = (p: Vec3): string =>
      `[${p
        .slice(0, 3)
        .map((v) => v.toFixed(3))
        .join(',')}]`;

    return {
      document: withEntity(doc, entity),
      summary: `Created tube ${id} from ${fmtPoint(p1)} to ${fmtPoint(p2)}, radius ${radius}, length ${length.toFixed(3)}.`,
      affected: [id],
    };
  },
});
