/**
 * Charts of the doubly curved faces and the parametric chart of any analytic face (03 WRP M4, TECHNICAL_SPEC §5.2).
 * - geodesic: the exponential map about the anchor. A chart point at distance rho and direction psi lands at the end of the geodesic of length rho leaving the
 *   anchor in direction psi (psi measured from the east direction, the way +u runs). Radial lengths are exact; circumferential lengths scale by the Jacobi
 *   field. Sphere: great circles in closed form. Torus: geodesic equations (Clairaut-free, RK4 at a step of a 400th of the tube radius).
 * - parametric: (u, v) = anchor + (x / Lu, y / Lv) with Lu, Lv the arc-length rates of the iso curves through the anchor (affine in (u, v), exact pcurves).
 * Sphere frame: the anchor sits at azimuth 0, latitude 0 of a frame whose polar axis is the local north (tangent), so the poles are a quarter turn away and
 * regions within the chart reach never touch them. East = world z cross the anchor direction (+x at the poles), north = anchor cross east.
 * @invariant the stretch of these charts is never hidden: callers measure `chartDistortion` and refuse above the named limit
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';
import { displacement, type ChartPlacement, type ChartResult, type FaceChart } from './chartFrame';
import type { SurfaceParams } from './kernelPorts';

const TWO_PI = 2 * Math.PI;
/** Largest share of the distance to the pole (a quarter great circle) a sphere chart reaches, and of the distance to the first conjugate point on a torus. */
const REACH_SHARE = 0.98;
const OUTSIDE =
  'a point of the sketch lies beyond the reach of the geodesic chart (a quarter great circle on a sphere, the tube half-turn on a torus)';
const POLE = 'a point of the sketch lies beyond the latitude the parametric chart reaches (the pole)';

type SphereSurface = Extract<SurfaceParams, { type: 'sphere' }>;
type TorusSurface = Extract<SurfaceParams, { type: 'torus' }>;

/** East (+u) and north (+v) unit tangents at the point of the sphere in direction `a` (a unit outward normal). */
function eastNorth(a: Vec3): { east: Vec3; north: Vec3 } {
  const raw = cross3([0, 0, 1], a);
  const east: Vec3 = Math.hypot(...raw) < 1e-9 ? [1, 0, 0] : normalize3(raw);
  return { east, north: cross3(a, east) };
}

function sphereBase(surface: SphereSurface, placement: ChartPlacement, method: 'geodesic' | 'parametric'): FaceChart {
  const { center, radius } = surface;
  const a = normalize3(sub3(placement.anchorOn, center));
  const { east, north } = eastNorth(a);
  const pointAt = ([u, v]: Vec2): Vec3 =>
    add3(
      center,
      scale3(add3(scale3(add3(scale3(a, Math.cos(u)), scale3(east, Math.sin(u))), Math.cos(v)), scale3(north, Math.sin(v))), radius),
    );
  const geodesic = (point: Vec2): Vec2 | null => {
    const [dx, dy] = displacement(placement, point);
    const rho = Math.hypot(dx, dy);
    if (rho > REACH_SHARE * (Math.PI / 2) * radius) return null;
    const psi = Math.atan2(dy, dx);
    const t = add3(scale3(east, Math.cos(psi)), scale3(north, Math.sin(psi)));
    const q = add3(scale3(a, Math.cos(rho / radius)), scale3(t, Math.sin(rho / radius)));
    return [Math.atan2(dot3(q, east), dot3(q, a)), Math.asin(Math.max(-1, Math.min(1, dot3(q, north))))];
  };
  const parametric = (point: Vec2): Vec2 | null => {
    const [dx, dy] = displacement(placement, point);
    const v = dy / radius;
    return Math.abs(v) > REACH_SHARE * (Math.PI / 2) ? null : [dx / radius, v];
  };
  return {
    kind: 'sphere',
    method,
    nullMeaning: method === 'geodesic' ? OUTSIDE : POLE,
    wire: { type: 'sphere', data: [...center, ...north, ...a, radius] },
    affine: method === 'parametric',
    anchorUv: [0, 0],
    anchorChart: placement.anchorChart,
    fullWrapWidth: TWO_PI * radius,
    uvAt: method === 'geodesic' ? geodesic : parametric,
    pointAt,
    normalAt: ([u, v]) => normalize3(sub3(pointAt([u, v]), center)),
    uvOfPoint: (point) => {
      const q = scale3(sub3(point, center), 1 / radius);
      return [Math.atan2(dot3(q, east), dot3(q, a)), Math.asin(Math.max(-1, Math.min(1, dot3(q, north))))];
    },
    metricBound: () => radius,
    areaG: (v) => radius * radius * Math.sin(v),
  };
}

/** One RK4 step of the torus geodesic equations in arc length: state (u, v, u', v'). */
function torusStep(
  major: number,
  minor: number,
  state: readonly [number, number, number, number],
  h: number,
): [number, number, number, number] {
  const field = ([, v, du, dv]: readonly [number, number, number, number]): [number, number, number, number] => {
    const ring = major + minor * Math.cos(v);
    return [du, dv, ((2 * minor * Math.sin(v)) / ring) * du * dv, -((ring * Math.sin(v)) / minor) * du * du];
  };
  const shifted = (k: readonly number[], factor: number): [number, number, number, number] => [
    state[0] + factor * (k[0] as number),
    state[1] + factor * (k[1] as number),
    state[2] + factor * (k[2] as number),
    state[3] + factor * (k[3] as number),
  ];
  const k1 = field(state);
  const k2 = field(shifted(k1, h / 2));
  const k3 = field(shifted(k2, h / 2));
  const k4 = field(shifted(k3, h));
  const mix = (index: number): number =>
    (state[index] as number) +
    (h / 6) * ((k1[index] as number) + 2 * (k2[index] as number) + 2 * (k3[index] as number) + (k4[index] as number));
  return [mix(0), mix(1), mix(2), mix(3)];
}

/** (u, v) at arc length `rho` along the torus geodesic leaving (0, v0) in direction `psi` from the u direction (exposed for the cross-check of `create_curve_on_face`). */
export function torusGeodesicEnd(major: number, minor: number, v0: number, psi: number, rho: number): Vec2 {
  const ring = major + minor * Math.cos(v0);
  let state: [number, number, number, number] = [0, v0, Math.cos(psi) / ring, Math.sin(psi) / minor];
  const steps = Math.max(1, Math.ceil(rho / (minor / 400)));
  const h = rho / steps;
  for (let k = 0; k < steps; k++) state = torusStep(major, minor, state, h);
  return [state[0], state[1]];
}

function torusBase(surface: TorusSurface, placement: ChartPlacement, method: 'geodesic' | 'parametric'): ChartResult {
  const { center, axis: rawAxis, major, minor } = surface;
  const axis = normalize3(rawAxis);
  const rel = sub3(placement.anchorOn, center);
  const height = dot3(rel, axis);
  const planar = sub3(rel, scale3(axis, height));
  const ringRadius = Math.hypot(...planar);
  if (!(ringRadius > 1e-9)) return { error: 'the anchor is on the axis of the torus' };
  const x = scale3(planar, 1 / ringRadius);
  const y = cross3(axis, x);
  const v0 = Math.atan2(height, ringRadius - major);
  const ring0 = major + minor * Math.cos(v0);
  const pointAt = ([u, v]: Vec2): Vec3 =>
    add3(
      add3(center, scale3(add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u))), major + minor * Math.cos(v))),
      scale3(axis, minor * Math.sin(v)),
    );
  const geodesic = (point: Vec2): Vec2 | null => {
    const [dx, dy] = displacement(placement, point);
    const rho = Math.hypot(dx, dy);
    if (rho > REACH_SHARE * Math.PI * minor) return null;
    return rho === 0 ? [0, v0] : torusGeodesicEnd(major, minor, v0, Math.atan2(dy, dx), rho);
  };
  const parametric = (point: Vec2): Vec2 | null => {
    const [dx, dy] = displacement(placement, point);
    return [dx / ring0, v0 + dy / minor];
  };
  return {
    kind: 'torus',
    method,
    nullMeaning: OUTSIDE,
    wire: { type: 'torus', data: [...center, ...axis, ...x, major, minor] },
    affine: method === 'parametric',
    anchorUv: [0, v0],
    anchorChart: placement.anchorChart,
    fullWrapWidth: TWO_PI * ring0,
    uvAt: method === 'geodesic' ? geodesic : parametric,
    pointAt,
    normalAt: ([u, v]) => add3(scale3(add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u))), Math.cos(v)), scale3(axis, Math.sin(v))),
    uvOfPoint: (point) => {
      const at = sub3(point, center);
      const h = dot3(at, axis);
      const p = sub3(at, scale3(axis, h));
      return [Math.atan2(dot3(p, y), dot3(p, x)), Math.atan2(h, Math.hypot(...p) - major)];
    },
    metricBound: () => major + minor,
    areaG: (v) => minor * (major * v + minor * Math.sin(v)),
  };
}

/** The geodesic or parametric chart of a sphere or torus face. @failure an anchor on the torus axis -> `{ error }` */
export function buildCurvedChart(
  surface: SphereSurface | TorusSurface,
  placement: ChartPlacement,
  method: 'geodesic' | 'parametric',
): ChartResult {
  return surface.type === 'sphere' ? sphereBase(surface, placement, method) : torusBase(surface, placement, method);
}

/**
 * The parametric chart over a developable face's `base` chart: (u, v) = anchor + (x / Lu, y / Lv), Lu and Lv the iso-curve speeds at the anchor.
 * @invariant plane and cylinder: identical to the development (Lu, Lv = the metric); cone: Lu = rho0 sin(alpha), Lv = 1, which is NOT an isometry
 */
export function parametricChartOf(base: FaceChart, placement: ChartPlacement): FaceChart {
  const speed = (du: number, dv: number): number => {
    const h = 1e-6 * (1 + Math.abs(base.anchorUv[0]) + Math.abs(base.anchorUv[1]));
    const a = base.pointAt([base.anchorUv[0] - du * h, base.anchorUv[1] - dv * h]);
    const b = base.pointAt([base.anchorUv[0] + du * h, base.anchorUv[1] + dv * h]);
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (2 * h);
  };
  const [lu, lv] = [speed(1, 0), speed(0, 1)];
  return {
    ...base,
    method: 'parametric',
    affine: true,
    fullWrapWidth: base.fullWrapWidth === null ? null : TWO_PI * lu,
    uvAt: (point) => {
      const [dx, dy] = displacement(placement, point);
      return [base.anchorUv[0] + dx / lu, base.anchorUv[1] + dy / lv];
    },
  };
}
