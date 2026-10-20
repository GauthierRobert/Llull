/**
 * Charts of the doubly curved tool faces (06 CMP M3): a hemispherical cap (azimuthal equidistant about the pole) and a `nurbs_surface` sheet
 * (scaled parameter rectangle). The chart is the part's 2D frame; it is NOT isometric away from its centre, so flat patterns come from drape.
 */

import type { PartSurface } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import { closestOnSurface, surfaceProbe, type SurfaceProbe } from '@lib/nurbs/closest';
import { evaluateSurface, surfaceDerivatives, surfaceDomain } from '@lib/nurbs/surface';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { add3, cross3, distance3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';

type SpherePart = Extract<PartSurface, { type: 'sphere' }>;
type NurbsPart = Extract<PartSurface, { type: 'nurbs' }>;

export interface CurvedHit {
  /** Point of the surface nearest the query. */
  readonly point: Vec3;
  /** Unit tool-outward normal there (NaN components at a degenerate pole). */
  readonly normal: Vec3;
  /** Chart coordinates of `point`. */
  readonly uv: Vec2;
  /** Distance from the query point to `point`. */
  readonly distance: number;
  /** Surface parameter of `point` (nurbs only), usable as a warm start for the next projection. */
  readonly param?: Vec2;
}

const yDirOfSphere = (surface: SpherePart): Vec3 => cross3(surface.axis, surface.xDir);

export function sphereHit(surface: SpherePart, query: Vec3): CurvedHit | null {
  const rel = sub3(query, surface.center);
  const radial = len3(rel);
  if (radial < 1e-12) return null;
  const direction = scale3(rel, 1 / radial);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot3(direction, surface.axis))));
  const phi = Math.atan2(dot3(direction, yDirOfSphere(surface)), dot3(direction, surface.xDir));
  return {
    point: add3(surface.center, scale3(direction, surface.radius)),
    normal: direction,
    uv: [surface.radius * theta * Math.cos(phi), surface.radius * theta * Math.sin(phi)],
    distance: Math.abs(radial - surface.radius),
  };
}

export function sphereFromFlat(surface: SpherePart, [u, v]: Vec2): Vec3 {
  return add3(surface.center, scale3(sphereDirection(surface, [u, v]), surface.radius));
}

/** Unit outward direction (= normal) of the sphere at a chart point. */
export function sphereDirection(surface: SpherePart, [u, v]: Vec2): Vec3 {
  const theta = Math.hypot(u, v) / surface.radius;
  const phi = Math.atan2(v, u);
  const around = add3(scale3(surface.xDir, Math.cos(phi)), scale3(yDirOfSphere(surface), Math.sin(phi)));
  return add3(scale3(surface.axis, Math.cos(theta)), scale3(around, Math.sin(theta)));
}

const probes = new WeakMap<NurbsSurfaceData, SurfaceProbe>();
const probeOf = (surface: NurbsSurfaceData): SurfaceProbe => {
  const cached = probes.get(surface);
  if (cached !== undefined) return cached;
  const fresh = surfaceProbe(surface);
  probes.set(surface, fresh);
  return fresh;
};

/** Unit normal Su x Sv at (u, v) (NaN components where the patch is degenerate). */
export function nurbsNormal(surface: NurbsSurfaceData, u: number, v: number): Vec3 {
  const d = surfaceDerivatives(surface, u, v, 1);
  const su = (d[1] as Vec3[])[0] as Vec3;
  const sv = (d[0] as Vec3[])[1] as Vec3;
  const n = cross3(su, sv);
  const length = len3(n);
  return length < 1e-14 ? [Number.NaN, Number.NaN, Number.NaN] : scale3(n, 1 / length);
}

const chartOf = (part: NurbsPart, u: number, v: number): Vec2 => [
  (u - part.domain[0][0]) * part.scale[0],
  (v - part.domain[1][0]) * part.scale[1],
];

/** Newton on the orthogonality conditions from a warm start; null when it did not settle. */
function refine(surface: NurbsSurfaceData, query: Vec3, hint: Vec2): { u: number; v: number } | null {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  let [u, v] = hint;
  for (let step = 0; step < 24; step++) {
    const d = surfaceDerivatives(surface, u, v, 2);
    const s = (d[0] as Vec3[])[0] as Vec3;
    const su = (d[1] as Vec3[])[0] as Vec3;
    const sv = (d[0] as Vec3[])[1] as Vec3;
    const suu = (d[2] as Vec3[])[0] as Vec3;
    const suv = (d[1] as Vec3[])[1] as Vec3;
    const svv = (d[0] as Vec3[])[2] as Vec3;
    const r = sub3(s, query);
    const [g1, g2] = [dot3(r, su), dot3(r, sv)];
    const [a, b, c] = [dot3(su, su) + dot3(r, suu), dot3(su, sv) + dot3(r, suv), dot3(sv, sv) + dot3(r, svv)];
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-18)) return null;
    const [du, dv] = [(-g1 * c + g2 * b) / det, (-a * g2 + b * g1) / det];
    const [nu, nv] = [Math.min(u1, Math.max(u0, u + du)), Math.min(v1, Math.max(v0, v + dv))];
    const moved = Math.hypot((nu - u) * len3(su), (nv - v) * len3(sv));
    [u, v] = [nu, nv];
    if (moved < 1e-12 * (1 + len3(s))) return { u, v };
  }
  return null;
}

/** Projection of `query` on a nurbs part surface; `hint` (a previous `param`) makes it a local Newton instead of a global search. */
export function nurbsHit(part: NurbsPart, query: Vec3, hint?: Vec2): CurvedHit {
  const { surface } = part;
  const local = hint === undefined ? null : refine(surface, query, hint);
  const best = local ?? closestOnSurface(surface, query, probeOf(surface));
  const point = evaluateSurface(surface, best.u, best.v);
  return {
    point,
    normal: nurbsNormal(surface, best.u, best.v),
    uv: chartOf(part, best.u, best.v),
    distance: distance3(point, query),
    param: [best.u, best.v],
  };
}

export function nurbsFromFlat(part: NurbsPart, [x, y]: Vec2): Vec3 {
  const [[u0, u1], [v0, v1]] = part.domain;
  const u = Math.min(u1, Math.max(u0, u0 + x / part.scale[0]));
  const v = Math.min(v1, Math.max(v0, v0 + y / part.scale[1]));
  return evaluateSurface(part.surface, u, v);
}

export function nurbsNormalAtFlat(part: NurbsPart, [x, y]: Vec2): Vec3 {
  const [[u0, u1], [v0, v1]] = part.domain;
  return nurbsNormal(part.surface, Math.min(u1, Math.max(u0, u0 + x / part.scale[0])), Math.min(v1, Math.max(v0, v0 + y / part.scale[1])));
}

/** Part-surface record of a world-space NURBS patch: parameter domain and the chart scale (arc length of the mid iso-curves per unit parameter). */
export function nurbsPartSurface(surface: NurbsSurfaceData): NurbsPart {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const arc = (along: 'u' | 'v'): number => {
    const steps = 64;
    let total = 0;
    let previous: Vec3 | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const point =
        along === 'u'
          ? evaluateSurface(surface, u0 + (u1 - u0) * t, (v0 + v1) / 2)
          : evaluateSurface(surface, (u0 + u1) / 2, v0 + (v1 - v0) * t);
      if (previous !== null) total += distance3(previous, point);
      previous = point;
    }
    return total;
  };
  const [lengthU, lengthV] = [arc('u'), arc('v')];
  return {
    type: 'nurbs',
    surface,
    domain: [
      [u0, u1],
      [v0, v1],
    ],
    scale: [lengthU / (u1 - u0), lengthV / (v1 - v0)],
  };
}

/** Chart rectangle (counter-clockwise) covering the whole parameter domain of a nurbs part. */
export function nurbsOutline(part: NurbsPart): Vec2[] {
  const [width, height] = [
    (part.domain[0][1] - part.domain[0][0]) * part.scale[0],
    (part.domain[1][1] - part.domain[1][0]) * part.scale[1],
  ];
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
}

/** Polar-angle cap of a sphere part: the outline is a circle of chart radius radius * pi / 2 (a hemisphere), `chord` the chord error. */
export function sphereOutline(surface: SpherePart, chord: number): Vec2[] {
  const radius = surface.radius * (Math.PI / 2);
  const sagitta = Math.min(Math.max(chord / radius, 1e-9), 1);
  const count = Math.max(24, Math.ceil(Math.PI / Math.acos(1 - sagitta)));
  return Array.from(
    { length: count },
    (_, i): Vec2 => [radius * Math.cos((2 * Math.PI * i) / count), radius * Math.sin((2 * Math.PI * i) / count)],
  );
}

/** Orthonormal azimuth-0 direction of a sphere part from a preferred direction (projected into the tangent plane at the pole), or null when parallel. */
export function sphereXDir(axis: Vec3, preferred: Vec3): Vec3 | null {
  const along = sub3(preferred, scale3(axis, dot3(preferred, axis)));
  return len3(along) < 1e-9 ? null : normalize3(along);
}
