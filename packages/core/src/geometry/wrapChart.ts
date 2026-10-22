/**
 * The chart that carries a sketch onto a plane, cylinder or cone face (03 WRP, TECHNICAL_SPEC §5.1): sketch point -> (u, v) of the face's own
 * surface description and back to 3D. The chart is the length-preserving development of the face (`surfaceChart`), placed by an anchor (a sketch
 * point lands on a face point), a turn and an optional mirror.
 * Frames: u is the azimuth about the axis from `xDir` with y = axis x xDir (cone: also), v the axial coordinate (plane: y = normal x xDir; cone: the distance
 * from the apex along the generator). The chart x axis follows +u and y follows +v, which seen from outside the face reads like a drawing.
 * @invariant plane and cylinder charts are affine (a NURBS sketch maps to an exact NURBS pcurve); the cone chart is polar and its pcurves are fitted
 */

import type { FaceSlabRecipe } from '../model/faceSlab';
import type { Vec2, Vec3 } from '../model/vectors';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../lib/vec3';
import type { SurfaceParams } from './kernelPorts';

export interface ChartPlacement {
  /** Sketch point that lands on `anchorOn`. */
  readonly anchorChart: Vec2;
  /** A point on the face. */
  readonly anchorOn: Vec3;
  readonly angleDeg: number;
  readonly mirror: boolean;
}

type ChartKind = 'plane' | 'cylinder' | 'cone';

export interface FaceChart {
  readonly kind: ChartKind;
  /** Wire form of the surface (`faceSlab` layout) whose (u, v) the chart produces. */
  readonly wire: FaceSlabRecipe['surface'];
  readonly affine: boolean;
  readonly anchorUv: Vec2;
  /** The sketch point that lands on the anchor. */
  readonly anchorChart: Vec2;
  /** Length of a full turn in the chart x direction at the anchor; null on a plane. */
  readonly fullWrapWidth: number | null;
  /** (u, v) of a chart point (a cone's polar angle is taken within half a turn of the anchor's). Null when the point falls on the cone apex. */
  readonly uvAt: (point: Vec2) => Vec2 | null;
  /** 3D point of (u, v). */
  readonly pointAt: (uv: Vec2) => Vec3;
  /** Unit normal in the direction of Su x Sv at (u, v): the sign reference of a lift (the kernel lifts along it, or against it when the wanted direction opposes it). */
  readonly normalAt: (uv: Vec2) => Vec3;
  /** (u, v) of a 3D point on the surface; the azimuth is wrapped to (-pi, pi]. */
  readonly uvOfPoint: (point: Vec3) => Vec2;
  /** Bound of the 3D length per unit of (u, v) change within `reach` (chart units) of the anchor: fit tolerances in (u, v) divide by it. */
  readonly metricBound: (reach: number) => number;
}

export type ChartResult = FaceChart | { readonly error: string };

const TWO_PI = 2 * Math.PI;

/** `axis` completed to a right-handed frame (x orthogonalised against it). */
function frameOf(axis: Vec3, xDir: Vec3): { axis: Vec3; x: Vec3; y: Vec3 } {
  const a = normalize3(axis);
  const x = normalize3(sub3(xDir, scale3(a, dot3(xDir, a))));
  return { axis: a, x, y: cross3(a, x) };
}

/** Chart displacement of sketch point `p` from the anchor: mirror y, turn by the angle. */
function displacement(placement: ChartPlacement, p: Vec2): Vec2 {
  const qx = p[0] - placement.anchorChart[0];
  const qy = (placement.mirror ? -1 : 1) * (p[1] - placement.anchorChart[1]);
  const angle = (placement.angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos * qx - sin * qy, sin * qx + cos * qy];
}

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
