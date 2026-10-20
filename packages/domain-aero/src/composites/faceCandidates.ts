/** Tool-face candidates of the analytic primitives (box, cylinder, cone): planes, cylinder / cone sides, any kernel (06 CMP §2). */

import type { Entity, Vec2, Vec3 } from '@core/model/types';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { projectOntoSegment, pointInPolygon } from '@lib/polygon';
import { ORIGIN, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';

export interface PlaneFace {
  readonly type: 'plane';
  readonly origin: Vec3;
  readonly xDir: Vec3;
  readonly yDir: Vec3;
  readonly normal: Vec3;
  /** Counter-clockwise outline in the (xDir, yDir) frame at `origin`. */
  readonly ring: readonly Vec2[];
}

export interface CylinderFace {
  readonly type: 'cylinder';
  /** Axis point at the start of the face (flat y = 0). */
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly xDir: Vec3;
  readonly radius: number;
  /** Azimuth range, radians. */
  readonly uRange: readonly [number, number];
  readonly length: number;
}

export interface ConeFace {
  readonly type: 'cone';
  readonly apex: Vec3;
  readonly axis: Vec3;
  readonly xDir: Vec3;
  readonly semiAngle: number;
  readonly uRange: readonly [number, number];
  /** Distances from the apex along the generator. */
  readonly rhoRange: readonly [number, number];
}

export type FaceCandidate = PlaneFace | CylinderFace | ConeFace;

/** Points of an arc of `radius` over `span` radians, at most `tolerance` (document units) from the true arc. */
export function arcSteps(radius: number, span: number, tolerance: number): number {
  const sagitta = Math.min(Math.max(tolerance / Math.max(radius, 1e-12), 1e-9), 1);
  return Math.max(8, Math.ceil(Math.abs(span) / (2 * Math.acos(1 - sagitta))));
}

function circleRing(radius: number, tolerance: number): Vec2[] {
  const n = arcSteps(radius, 2 * Math.PI, tolerance);
  return Array.from({ length: n }, (_, i): Vec2 => [radius * Math.cos((2 * Math.PI * i) / n), radius * Math.sin((2 * Math.PI * i) / n)]);
}

/** The faces of `entity` when it is a box, cylinder or cone (any rotation / position); null for other kinds. */
export function primitiveFaces(entity: Entity, tolerance: number): FaceCandidate[] | null {
  const point = (local: Vec3): Vec3 => entityLocalToWorld(entity, local);
  const dir = (local: Vec3): Vec3 => applyEulerXYZ(local, ORIGIN, entity.rotation);
  const [ex, ey, ez] = [dir([1, 0, 0]), dir([0, 1, 0]), dir([0, 0, 1])];
  const neg = (v: Vec3): Vec3 => scale3(v, -1);
  if (entity.kind === 'box') {
    const [a, b, c] = [entity.size[0] / 2, entity.size[1] / 2, entity.size[2] / 2];
    const rect = (u: number, v: number): Vec2[] => [
      [-u, -v],
      [u, -v],
      [u, v],
      [-u, v],
    ];
    const plane = (centre: Vec3, xDir: Vec3, yDir: Vec3, ring: Vec2[]): PlaneFace => ({
      type: 'plane',
      origin: point(centre),
      xDir,
      yDir,
      normal: cross3(xDir, yDir),
      ring,
    });
    return [
      plane([0, 0, c], ex, ey, rect(a, b)),
      plane([0, 0, -c], ex, neg(ey), rect(a, b)),
      plane([a, 0, 0], ey, ez, rect(b, c)),
      plane([-a, 0, 0], ey, neg(ez), rect(b, c)),
      plane([0, b, 0], ez, ex, rect(c, a)),
      plane([0, -b, 0], ez, neg(ex), rect(c, a)),
    ];
  }
  if (entity.kind === 'cylinder') {
    const half = entity.height / 2;
    const ring = circleRing(entity.radius, tolerance);
    return [
      {
        type: 'cylinder',
        origin: point([0, 0, -half]),
        axis: ez,
        xDir: ex,
        radius: entity.radius,
        uRange: [0, 2 * Math.PI],
        length: entity.height,
      },
      { type: 'plane', origin: point([0, 0, half]), xDir: ex, yDir: ey, normal: ez, ring },
      { type: 'plane', origin: point([0, 0, -half]), xDir: ex, yDir: neg(ey), normal: neg(ez), ring },
    ];
  }
  if (entity.kind === 'cone') {
    const slant = Math.hypot(entity.radius, entity.height);
    return [
      {
        type: 'cone',
        apex: point([0, 0, entity.height]),
        axis: neg(ez),
        xDir: ex,
        semiAngle: Math.atan2(entity.radius, entity.height),
        uRange: [0, 2 * Math.PI],
        rhoRange: [0, slant],
      },
      { type: 'plane', origin: point([0, 0, 0]), xDir: ex, yDir: neg(ey), normal: neg(ez), ring: circleRing(entity.radius, tolerance) },
    ];
  }
  return null;
}

/** Distance (document units) from `p` to the finite face. */
export function distanceToFace(face: FaceCandidate, p: Vec3): number {
  if (face.type === 'plane') {
    const rel = sub3(p, face.origin);
    const local: Vec2 = [dot3(rel, face.xDir), dot3(rel, face.yDir)];
    const offset = Math.abs(dot3(rel, face.normal));
    if (pointInPolygon(local, face.ring)) return offset;
    const edge = Math.min(...face.ring.map((a, i) => projectOntoSegment(local, a, face.ring[(i + 1) % face.ring.length] as Vec2).distance));
    return Math.hypot(offset, edge);
  }
  if (face.type === 'cylinder') {
    const rel = sub3(p, face.origin);
    const along = dot3(rel, face.axis);
    const radial = len3(sub3(rel, scale3(face.axis, along)));
    return Math.hypot(radial - face.radius, Math.max(0, -along, along - face.length));
  }
  const rel = sub3(p, face.apex);
  const along = dot3(rel, face.axis);
  const radial = len3(sub3(rel, scale3(face.axis, along)));
  const [rho0, rho1] = face.rhoRange;
  const a: Vec2 = [rho0 * Math.cos(face.semiAngle), rho0 * Math.sin(face.semiAngle)];
  const b: Vec2 = [rho1 * Math.cos(face.semiAngle), rho1 * Math.sin(face.semiAngle)];
  return projectOntoSegment([along, radial], a, b).distance;
}
