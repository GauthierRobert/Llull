/**
 * The chart that carries a sketch onto a plane, cylinder or cone face (03 WRP, TECHNICAL_SPEC §5.1): sketch point -> (u, v) of the face's own
 * surface description and back to 3D. The chart is the length-preserving development of the face (`surfaceChart`), placed by an anchor (a sketch
 * point lands on a face point), a turn and an optional mirror.
 * Frames: u is the azimuth about the axis from `xDir` with y = axis x xDir (cone: also), v the axial coordinate (plane: y = normal x xDir; cone: the distance
 * from the apex along the generator). The chart x axis follows +u and y follows +v, which seen from outside the face reads like a drawing.
 * @invariant plane and cylinder charts are affine (a NURBS sketch maps to an exact NURBS pcurve); the cone chart is polar and its pcurves are fitted
 */

import type { Vec2 } from '../model/vectors';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../lib/vec3';
import { displacement, frameOf, type ChartPlacement, type ChartResult, type FaceChart } from './chartFrame';
import type { SurfaceParams } from './kernelPorts';

const TWO_PI = 2 * Math.PI;

const APEX = 'a point of the curve falls on the apex of the cone';

function planeChart(surface: Extract<SurfaceParams, { type: 'plane' }>, placement: ChartPlacement): FaceChart {
  const x = normalize3(sub3(surface.xDir, scale3(normalize3(surface.normal), dot3(surface.xDir, normalize3(surface.normal)))));
  const y = cross3(normalize3(surface.normal), x);
  const rel = sub3(placement.anchorOn, surface.origin);
  const anchorUv: Vec2 = [dot3(rel, x), dot3(rel, y)];
  const uv = (p: Vec2): Vec2 => {
    const [dx, dy] = displacement(placement, p);
    return [anchorUv[0] + dx, anchorUv[1] + dy];
  };
  return {
    kind: 'plane',
    method: 'develop',
    nullMeaning: APEX,
    areaG: (v) => v,
    wire: { type: 'plane', data: [...surface.origin, ...x, ...y] },
    affine: true,
    anchorUv,
    anchorChart: placement.anchorChart,
    fullWrapWidth: null,
    uvAt: uv,
    pointAt: ([u, v]) => add3(surface.origin, add3(scale3(x, u), scale3(y, v))),
    uvOfPoint: (point) => [dot3(sub3(point, surface.origin), x), dot3(sub3(point, surface.origin), y)],
    normalAt: () => cross3(x, y),
    metricBound: () => 1,
  };
}

function cylinderChart(surface: Extract<SurfaceParams, { type: 'cylinder' }>, placement: ChartPlacement): FaceChart {
  const { axis, x, y } = frameOf(surface.axis, surface.xDir);
  const rel = sub3(placement.anchorOn, surface.origin);
  const anchorUv: Vec2 = [Math.atan2(dot3(rel, y), dot3(rel, x)), dot3(rel, axis)];
  const radius = surface.radius;
  const uv = (p: Vec2): Vec2 => {
    const [dx, dy] = displacement(placement, p);
    return [anchorUv[0] + dx / radius, anchorUv[1] + dy];
  };
  return {
    kind: 'cylinder',
    method: 'develop',
    nullMeaning: APEX,
    areaG: (v) => radius * v,
    wire: { type: 'cylinder', data: [...surface.origin, ...axis, ...x, radius] },
    affine: true,
    anchorUv,
    anchorChart: placement.anchorChart,
    fullWrapWidth: TWO_PI * radius,
    uvAt: uv,
    pointAt: ([u, v]) => add3(add3(surface.origin, scale3(axis, v)), scale3(add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u))), radius)),
    uvOfPoint: (point) => {
      const at = sub3(point, surface.origin);
      return [Math.atan2(dot3(at, y), dot3(at, x)), dot3(at, axis)];
    },
    normalAt: ([u]) => add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u))),
    metricBound: () => Math.max(radius, 1) + 1,
  };
}

function coneChart(surface: Extract<SurfaceParams, { type: 'cone' }>, placement: ChartPlacement): ChartResult {
  const { axis, x, y } = frameOf(surface.axis, surface.xDir);
  const alpha = surface.semiAngle;
  const sin = Math.sin(alpha);
  const cos = Math.cos(alpha);
  const rel = sub3(placement.anchorOn, surface.apex);
  const rho0 = len3(rel);
  if (!(rho0 > 1e-9)) return { error: 'the anchor is at the cone apex' };
  const u0 = Math.atan2(dot3(rel, y), dot3(rel, x));
  const phi0 = u0 * sin;
  const radial: Vec2 = [Math.cos(phi0), Math.sin(phi0)];
  const tangent: Vec2 = [-Math.sin(phi0), Math.cos(phi0)];
  const uvAt = (point: Vec2): Vec2 | null => {
    const [dx, dy] = displacement(placement, point);
    const fx = rho0 * radial[0] + dx * tangent[0] + dy * radial[0];
    const fy = rho0 * radial[1] + dx * tangent[1] + dy * radial[1];
    const rho = Math.hypot(fx, fy);
    if (!(rho > 1e-9)) return null;
    const phi = phi0 + Math.atan2(Math.sin(Math.atan2(fy, fx) - phi0), Math.cos(Math.atan2(fy, fx) - phi0));
    return [phi / sin, rho];
  };
  return {
    kind: 'cone',
    method: 'develop',
    nullMeaning: APEX,
    areaG: (v) => (sin * v * v) / 2,
    wire: { type: 'cone', data: [...surface.apex, ...axis, ...x, alpha] },
    affine: false,
    anchorUv: [u0, rho0],
    anchorChart: placement.anchorChart,
    fullWrapWidth: TWO_PI * rho0 * sin,
    uvAt,
    pointAt: ([u, v]) => {
      const radialDirection = add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u)));
      return add3(surface.apex, scale3(add3(scale3(axis, cos), scale3(radialDirection, sin)), v));
    },
    uvOfPoint: (point) => {
      const at = sub3(point, surface.apex);
      return [Math.atan2(dot3(at, y), dot3(at, x)), len3(at)];
    },
    normalAt: ([u]) => add3(scale3(add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u))), cos), scale3(axis, -sin)),
    metricBound: (reach) => Math.max(1, sin * (rho0 + reach) + 1),
  };
}

/**
 * The chart of `surface` for `placement`.
 * @failure sphere, torus and freeform faces (Gaussian curvature != 0) -> `{ error: 'not_developable' }`; a cone anchored at its apex -> error text
 */
export function buildFaceChart(surface: SurfaceParams, placement: ChartPlacement): ChartResult {
  switch (surface.type) {
    case 'plane':
      return planeChart(surface, placement);
    case 'cylinder':
      return cylinderChart(surface, placement);
    case 'cone':
      return coneChart(surface, placement);
    default:
      return { error: 'not_developable' };
  }
}
