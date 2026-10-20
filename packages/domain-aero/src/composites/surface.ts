/**
 * The developed frame of a part's tool face (06 CMP §5.7): `toFlat` / `fromFlat` map between the 3D face and the flat pattern.
 * Plane: face frame. Cylinder: (arc length from azimuth 0, axial). Cone: polar development about the apex, angle = azimuth * sin(semi-angle).
 * Orientation: flat seen from the tool-outward side (normal toward the viewer); ply angles run counter-clockwise from the 0-degree direction.
 */

import type { PartSurface } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';

const TWO_PI = 2 * Math.PI;

const wrap = (angle: number): number => ((angle % TWO_PI) + TWO_PI) % TWO_PI;

/** Second azimuth axis of a cylinder / cone about its axis (cone azimuth runs the other way so the development stays right-handed). */
const yDirOf = (surface: Extract<PartSurface, { type: 'cylinder' | 'cone' }>): Vec3 =>
  surface.type === 'cylinder' ? cross3(surface.axis, surface.xDir) : cross3(surface.xDir, surface.axis);

export interface FlatHit {
  readonly uv: Vec2;
  /** Signed distance from the tool surface along its outward normal (document units). */
  readonly offset: number;
}

export function toFlat(surface: PartSurface, point: Vec3): FlatHit {
  if (surface.type === 'plane') {
    const rel = sub3(point, surface.origin);
    return { uv: [dot3(rel, surface.xDir), dot3(rel, surface.yDir)], offset: dot3(rel, surface.normal) };
  }
  const rel = sub3(point, surface.type === 'cylinder' ? surface.origin : surface.apex);
  const azimuth = wrap(Math.atan2(dot3(rel, yDirOf(surface)), dot3(rel, surface.xDir)));
  if (surface.type === 'cylinder') {
    const radial = Math.hypot(dot3(rel, surface.xDir), dot3(rel, yDirOf(surface)));
    return { uv: [surface.radius * azimuth, dot3(rel, surface.axis)], offset: radial - surface.radius };
  }
  const rho = len3(rel);
  const beta = rho === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot3(rel, surface.axis) / rho)));
  const angle = azimuth * Math.sin(surface.semiAngle);
  return { uv: [rho * Math.cos(angle), rho * Math.sin(angle)], offset: rho * Math.sin(beta - surface.semiAngle) };
}

export function fromFlat(surface: PartSurface, [u, v]: Vec2): Vec3 {
  if (surface.type === 'plane') return add3(surface.origin, add3(scale3(surface.xDir, u), scale3(surface.yDir, v)));
  const yDir = yDirOf(surface);
  if (surface.type === 'cylinder') {
    const azimuth = u / surface.radius;
    const radial = add3(scale3(surface.xDir, Math.cos(azimuth)), scale3(yDir, Math.sin(azimuth)));
    return add3(add3(surface.origin, scale3(surface.axis, v)), scale3(radial, surface.radius));
  }
  return coneAt(surface, Math.hypot(u, v), coneTheta(surface, [u, v]));
}

/** Point of a cone at distance `rho` from the apex and flat polar angle `theta` (radians, not wrapped). */
function coneAt(surface: Extract<PartSurface, { type: 'cone' }>, rho: number, theta: number): Vec3 {
  const azimuth = theta / Math.sin(surface.semiAngle);
  const radial = add3(scale3(surface.xDir, Math.cos(azimuth)), scale3(yDirOf(surface), Math.sin(azimuth)));
  const generator = add3(scale3(surface.axis, Math.cos(surface.semiAngle)), scale3(radial, Math.sin(surface.semiAngle)));
  return add3(surface.apex, scale3(generator, rho));
}

/** Unit tool-outward normal at the flat point. */
export function normalAt(surface: PartSurface, uv: Vec2): Vec3 {
  if (surface.type === 'plane') return surface.normal;
  const yDir = yDirOf(surface);
  if (surface.type === 'cylinder') {
    const azimuth = uv[0] / surface.radius;
    return add3(scale3(surface.xDir, Math.cos(azimuth)), scale3(yDir, Math.sin(azimuth)));
  }
  const azimuth = coneTheta(surface, uv) / Math.sin(surface.semiAngle);
  const radial = add3(scale3(surface.xDir, Math.cos(azimuth)), scale3(yDir, Math.sin(azimuth)));
  return normalize3(sub3(scale3(radial, Math.cos(surface.semiAngle)), scale3(surface.axis, Math.sin(surface.semiAngle))));
}

/** Unit 0-degree direction in the flat frame at `uv`: +x on a plane, the axis (+y) on a cylinder, the meridian (radial) on a cone. */
export function zeroDirection(surface: PartSurface, uv: Vec2): Vec2 {
  if (surface.type === 'plane') return [1, 0];
  if (surface.type === 'cylinder') return [0, 1];
  const rho = Math.hypot(uv[0], uv[1]);
  return rho === 0 ? [1, 0] : [uv[0] / rho, uv[1] / rho];
}

/** Unit fibre direction in the flat frame for a ply at `angleDeg` (counter-clockwise from the 0-degree direction). */
export function fibreDirection(surface: PartSurface, uv: Vec2, angleDeg: number): Vec2 {
  const [x, y] = zeroDirection(surface, uv);
  const theta = (angleDeg * Math.PI) / 180;
  return [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)];
}

/** Unit 3D fibre direction at `uv`: the surface image of the flat direction (central difference through `fromFlat`). */
export function fibreDirection3d(surface: PartSurface, uv: Vec2, angleDeg: number): Vec3 {
  const [dx, dy] = fibreDirection(surface, uv, angleDeg);
  const step = 1e-4 * (1 + Math.hypot(uv[0], uv[1]));
  if (surface.type === 'cone') {
    const base = Math.atan2(uv[1], uv[0]);
    const theta0 = coneTheta(surface, uv);
    const at = (sign: number): Vec3 => {
      const p: Vec2 = [uv[0] + sign * dx * step, uv[1] + sign * dy * step];
      const delta = Math.atan2(Math.sin(Math.atan2(p[1], p[0]) - base), Math.cos(Math.atan2(p[1], p[0]) - base));
      return coneAt(surface, Math.hypot(p[0], p[1]), theta0 + delta);
    };
    return normalize3(sub3(at(1), at(-1)));
  }
  return normalize3(
    sub3(fromFlat(surface, [uv[0] + dx * step, uv[1] + dy * step]), fromFlat(surface, [uv[0] - dx * step, uv[1] - dy * step])),
  );
}

/**
 * Flat polar angle of `uv` on the sector of a cone (0 .. 2 pi sin(half angle)); a point just before the seam keeps a small negative angle.
 * @invariant atan2 is lifted by 2 pi only when the result still lies inside the sector, so wide cones (sector above pi) map correctly
 */
function coneTheta(surface: Extract<PartSurface, { type: 'cone' }>, [u, v]: Vec2): number {
  const theta = Math.atan2(v, u);
  return theta < 0 && theta + TWO_PI <= TWO_PI * Math.sin(surface.semiAngle) + 1e-9 ? theta + TWO_PI : theta;
}
