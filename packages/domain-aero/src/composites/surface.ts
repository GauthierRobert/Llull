/**
 * The developed frame of a part's tool face (06 CMP §5.7): `toFlat` / `fromFlat` map between the 3D face and the flat pattern.
 * Plane, cylinder and cone use the length-preserving core chart (`@core/geometry/surfaceChart`, 03 WRP M0); the sphere cap and the NURBS sheet
 * keep their own non-isometric charts (`./curved`).
 * Orientation: flat seen from the tool-outward side (normal toward the viewer); ply angles run counter-clockwise from the 0-degree direction.
 */

import type { PartSurface } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import * as chart from '@core/geometry/surfaceChart';
import { dot3, normalize3, sub3 } from '@lib/vec3';
import { nurbsFromFlat, nurbsHit, nurbsNormalAtFlat, sphereDirection, sphereFromFlat, sphereHit } from './curved';

/** True for the faces whose chart is not isometric (sphere cap, NURBS sheet): their flat patterns come from drape, not from the chart. */
export const isDoublyCurved = (surface: PartSurface): boolean => !chart.isDevelopable(surface);

export function toFlat(surface: PartSurface, point: Vec3): chart.FlatHit {
  if (chart.isDevelopable(surface)) return chart.toFlat(surface, point);
  const hit = surface.type === 'sphere' ? sphereHit(surface, point) : nurbsHit(surface, point);
  if (hit === null) return { uv: [0, 0], offset: 0 };
  return { uv: hit.uv, offset: dot3(sub3(point, hit.point), hit.normal) };
}

export function fromFlat(surface: PartSurface, uv: Vec2): Vec3 {
  if (chart.isDevelopable(surface)) return chart.fromFlat(surface, uv);
  return surface.type === 'sphere' ? sphereFromFlat(surface, uv) : nurbsFromFlat(surface, uv);
}

/** Unit tool-outward normal at the flat point. */
export function normalAt(surface: PartSurface, uv: Vec2): Vec3 {
  if (chart.isDevelopable(surface)) return chart.normalAt(surface, uv);
  return surface.type === 'sphere' ? sphereDirection(surface, uv) : nurbsNormalAtFlat(surface, uv);
}

/** Unit 0-degree direction in the flat frame at `uv`: +x on a plane, the axis (+y) on a cylinder, the meridian (radial) on a cone. */
export function zeroDirection(surface: PartSurface, uv: Vec2): Vec2 {
  return chart.isDevelopable(surface) ? chart.zeroDirection(surface, uv) : [1, 0];
}

/** Unit fibre direction in the flat frame for a ply at `angleDeg` (counter-clockwise from the 0-degree direction). */
export function fibreDirection(surface: PartSurface, uv: Vec2, angleDeg: number): Vec2 {
  const [x, y] = zeroDirection(surface, uv);
  const theta = (angleDeg * Math.PI) / 180;
  return [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)];
}

/** Unit 3D fibre direction at `uv`: the surface image of the flat direction (central difference through `fromFlat`). */
export function fibreDirection3d(surface: PartSurface, uv: Vec2, angleDeg: number): Vec3 {
  const direction = fibreDirection(surface, uv, angleDeg);
  if (chart.isDevelopable(surface)) return chart.directionOnFace(surface, uv, direction);
  const [dx, dy] = direction;
  const step = 1e-4 * (1 + Math.hypot(uv[0], uv[1]));
  return normalize3(
    sub3(fromFlat(surface, [uv[0] + dx * step, uv[1] + dy * step]), fromFlat(surface, [uv[0] - dx * step, uv[1] - dy * step])),
  );
}
