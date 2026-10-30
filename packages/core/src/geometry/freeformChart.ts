/**
 * Charts of a freeform (B-spline) face (03 WRP M4, TECHNICAL_SPEC §14.10), built on the exact B-spline of the face (`faceQuery.bspline`, the face's own (u, v)).
 * - geodesic: the exponential map about the anchor. A chart point at distance rho and direction psi (psi from the +u tangent, turning towards +Su x Sv) lands at the
 *   end of the geodesic of length rho leaving the anchor in that direction. The geodesic equations are integrated in arc length by RK4 with the Christoffel symbols
 *   of the exact first and second derivatives; the Jacobi field J'' + K J = 0 (K the Gaussian curvature of the surface) rides along, J / rho being the ratio of the
 *   circumference of a geodesic circle to the chart's: where it drops under `FOLD_RATIO` the map is folding (a conjugate point) and the chart is refused.
 * - parametric: (u, v) = anchor + (x / |Su|, y / |Sv|), the arc-length rates of the iso curves through the anchor (affine, exact pcurves).
 * @invariant radial lengths of the geodesic chart are exact; circumferential lengths scale by J / rho; stretch is never hidden, callers measure `chartDistortion`
 * @failure a periodic surface, a degenerate tangent frame at the anchor -> `{ error }`; a chart point whose geodesic leaves the parameter box or folds -> uvAt null
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { evaluateSurface, surfaceDerivatives, surfaceDomain } from '../lib/nurbs/surface';
import type { NurbsSurfaceData as SurfaceData } from '../lib/nurbs/surfaceTypes';
import { cross3, dot3, normalize3 } from '../lib/vec3';
import { displacement, type ChartPlacement, type ChartResult, type FaceChart } from './chartFrame';
import type { FaceQueryPort } from './kernelPorts';

type PortSurface = NonNullable<ReturnType<FaceQueryPort['bspline']>>;

/** J / rho under this: the exponential map is folding (a conjugate point is near). */
const FOLD_RATIO = 0.05;
const STEPS_PER_DIAGONAL = 100;
const MIN_STEPS = 8;
const MAX_STEPS = 4000;
const GRID = 11;
const GAUSS: ReadonlyArray<readonly [number, number]> = [
  [-0.9602898564975363, 0.1012285362903763],
  [-0.7966664774136267, 0.2223810344533745],
  [-0.525532409916329, 0.3137066458778873],
  [-0.1834346424956498, 0.362683783378362],
  [0.1834346424956498, 0.362683783378362],
  [0.525532409916329, 0.3137066458778873],
  [0.7966664774136267, 0.2223810344533745],
  [0.9602898564975363, 0.1012285362903763],
];

const OUTSIDE = 'a point of the sketch lies beyond the parameter box of the freeform face (the geodesic leaves the surface)';
const FOLDED =
  'the geodesic chart folds there: a point of the sketch lies at or beyond a conjugate point of the exponential map (the surface curves too much for a chart this large)';

/** The port's B-spline in the form the NURBS evaluators read (`multsU` -> `multiplicitiesU`). */
export function surfaceOfPort(data: PortSurface): SurfaceData {
  return {
    degreeU: data.degreeU,
    degreeV: data.degreeV,
    poles: data.poles,
    ...(data.weights === undefined ? {} : { weights: data.weights }),
    knotsU: data.knotsU,
    multiplicitiesU: data.multsU,
    knotsV: data.knotsV,
    multiplicitiesV: data.multsV,
  };
}

interface Differential {
  readonly point: Vec3;
  readonly su: Vec3;
  readonly sv: Vec3;
  readonly suu: Vec3;
  readonly suv: Vec3;
  readonly svv: Vec3;
  readonly e: number;
  readonly f: number;
  readonly g: number;
  readonly det: number;
}

function differential(surface: SurfaceData, u: number, v: number): Differential {
  const d = surfaceDerivatives(surface, u, v, 2);
  const at = (k: number, l: number): Vec3 => ((d[k] as Vec3[])[l] as Vec3) ?? [0, 0, 0];
  const [su, sv] = [at(1, 0), at(0, 1)];
  const [e, f, g] = [dot3(su, su), dot3(su, sv), dot3(sv, sv)];
  return { point: at(0, 0), su, sv, suu: at(2, 0), suv: at(1, 1), svv: at(0, 2), e, f, g, det: e * g - f * f };
}

type State = readonly [number, number, number, number, number, number];
type Shot = { readonly uv: Vec2; readonly minRatio: number } | 'outside' | 'fold';

export function buildFreeformChart(
  data: PortSurface,
  anchorUv: Vec2,
  placement: ChartPlacement,
  method: 'geodesic' | 'parametric',
): ChartResult {
  if (data.periodicU || data.periodicV)
    return { error: 'the freeform face is periodic in u or v; charts are built on non-periodic B-spline faces' };
  const surface = surfaceOfPort(data);
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const anchor = differential(surface, anchorUv[0], anchorUv[1]);
  if (!(anchor.det > 1e-18 * (1 + anchor.e * anchor.g))) return { error: 'the surface is degenerate at the anchor (zero tangent area)' };
  const normal = normalize3(cross3(anchor.su, anchor.sv));
  const east = normalize3(anchor.su);
  const north = cross3(normal, east);
  const poles: Vec3[] = data.poles.flat();
  const lo = [0, 1, 2].map((a) => Math.min(...poles.map((p) => p[a] as number)));
  const hi = [0, 1, 2].map((a) => Math.max(...poles.map((p) => p[a] as number)));
  const diagonal = Math.hypot(...[0, 1, 2].map((a) => (hi[a] as number) - (lo[a] as number)));
  const stepLength = diagonal / STEPS_PER_DIAGONAL;
  const inBox = (u: number, v: number): boolean => {
    const [tu, tv] = [1e-9 * (u1 - u0), 1e-9 * (v1 - v0)];
    return u >= u0 - tu && u <= u1 + tu && v >= v0 - tv && v <= v1 + tv;
  };

  const field = (s: State): State => {
    const q = differential(surface, s[0], s[1]);
    const [du, dv] = [s[2], s[3]];
    const a = [0, 1, 2].map(
      (c) => -((q.suu[c] as number) * du * du + 2 * (q.suv[c] as number) * du * dv + (q.svv[c] as number) * dv * dv),
    ) as unknown as Vec3;
    const [r1, r2] = [dot3(a, q.su), dot3(a, q.sv)];
    const n = normalize3(cross3(q.su, q.sv));
    const gauss = (dot3(q.suu, n) * dot3(q.svv, n) - dot3(q.suv, n) ** 2) / q.det;
    return [du, dv, (q.g * r1 - q.f * r2) / q.det, (q.e * r2 - q.f * r1) / q.det, s[5], -gauss * s[4]];
  };
  const advance = (s: State, k: State, h: number): State => s.map((x, i) => x + h * (k[i] as number)) as unknown as State;

  /** The geodesic of length `rho` leaving the anchor in direction `psi`. */
  const shoot = (psi: number, rho: number): Shot => {
    const tangent = [0, 1, 2].map((c) => Math.cos(psi) * (east[c] as number) + Math.sin(psi) * (north[c] as number)) as unknown as Vec3;
    const [ts, tv] = [dot3(tangent, anchor.su), dot3(tangent, anchor.sv)];
    let s: State = [
      anchorUv[0],
      anchorUv[1],
      (anchor.g * ts - anchor.f * tv) / anchor.det,
      (anchor.e * tv - anchor.f * ts) / anchor.det,
      0,
      1,
    ];
    const steps = Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.ceil(rho / stepLength)));
    const h = rho / steps;
    let minRatio = 1;
    for (let k = 0; k < steps; k++) {
      const k1 = field(s);
      const k2 = field(advance(s, k1, h / 2));
      const k3 = field(advance(s, k2, h / 2));
      const k4 = field(advance(s, k3, h));
      s = s.map(
        (x, i) => x + (h / 6) * ((k1[i] as number) + 2 * (k2[i] as number) + 2 * (k3[i] as number) + (k4[i] as number)),
      ) as unknown as State;
      if (!inBox(s[0], s[1])) return 'outside';
      minRatio = Math.min(minRatio, s[4] / ((k + 1) * h));
      if (minRatio < FOLD_RATIO) return 'fold';
    }
    return { uv: [Math.min(u1, Math.max(u0, s[0])), Math.min(v1, Math.max(v0, s[1]))], minRatio };
  };

  const polar = (point: Vec2): { psi: number; rho: number } => {
    const [dx, dy] = displacement(placement, point);
    return { psi: Math.atan2(dy, dx), rho: Math.hypot(dx, dy) };
  };
  const [lu, lv] = [Math.sqrt(anchor.e), Math.sqrt(anchor.g)];
  const parametric = (point: Vec2): Vec2 | null => {
    const [dx, dy] = displacement(placement, point);
    const uv: Vec2 = [anchorUv[0] + dx / lu, anchorUv[1] + dy / lv];
    return inBox(uv[0], uv[1]) ? uv : null;
  };
  const geodesic = (point: Vec2): Vec2 | null => {
    const { psi, rho } = polar(point);
    if (rho === 0) return anchorUv;
    const shot = shoot(psi, rho);
    return typeof shot === 'string' ? null : shot.uv;
  };

  let bound: number | null = null;
  const metricBound = (): number => {
    if (bound === null) {
      let top = 0;
      for (let i = 0; i < GRID; i++)
        for (let j = 0; j < GRID; j++) {
          const q = differential(surface, u0 + ((u1 - u0) * i) / (GRID - 1), v0 + ((v1 - v0) * j) / (GRID - 1));
          top = Math.max(top, Math.sqrt(q.e) + Math.sqrt(q.g));
        }
      bound = 1.25 * top;
    }
    return bound;
  };

  const chart: FaceChart = {
    kind: 'freeform',
    method,
    nullMeaning: method === 'geodesic' ? `${OUTSIDE}; or ${FOLDED}` : OUTSIDE,
    wire: { type: 'face', data: [] },
    affine: method === 'parametric',
    anchorUv,
    anchorChart: placement.anchorChart,
    fullWrapWidth: null,
    uvAt: method === 'geodesic' ? geodesic : parametric,
    pointAt: ([u, v]) => evaluateSurface(surface, u, v),
    normalAt: ([u, v]) => {
      const q = differential(surface, u, v);
      return normalize3(cross3(q.su, q.sv));
    },
    uvOfPoint: (target) => closestUv(surface, target, [u0, u1, v0, v1]),
    metricBound,
    areaG: (v, u) => {
      let total = 0;
      const pieces = Math.max(1, Math.ceil((Math.abs(v - v0) / (v1 - v0)) * 4));
      for (let p = 0; p < pieces; p++) {
        const [a, b] = [v0 + ((v - v0) * p) / pieces, v0 + ((v - v0) * (p + 1)) / pieces];
        for (const [x, w] of GAUSS) {
          const q = differential(surface, u, a + ((x + 1) / 2) * (b - a));
          total += (w * (b - a) * Math.sqrt(Math.max(0, q.det))) / 2;
        }
      }
      return total;
    },
    diagnose: (point) => {
      if (method === 'parametric') return parametric(point) === null ? 'outside' : null;
      const { psi, rho } = polar(point);
      if (rho === 0) return null;
      const shot = shoot(psi, rho);
      return typeof shot === 'string' ? shot : null;
    },
  };
  return chart;
}

/** (u, v) of the point of the surface closest to `target`: the nearest of a grid, then Gauss-Newton on the tangent frame (clamped to the parameter box). */
function closestUv(surface: SurfaceData, target: Vec3, box: readonly [number, number, number, number]): Vec2 {
  const [u0, u1, v0, v1] = box;
  let best: Vec2 = [u0, v0];
  let bestDistance = Infinity;
  for (let i = 0; i < 17; i++)
    for (let j = 0; j < 17; j++) {
      const uv: Vec2 = [u0 + ((u1 - u0) * i) / 16, v0 + ((v1 - v0) * j) / 16];
      const p = evaluateSurface(surface, uv[0], uv[1]);
      const d = Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2]);
      if (d < bestDistance) [best, bestDistance] = [uv, d];
    }
  let [u, v] = best;
  for (let k = 0; k < 12; k++) {
    const q = differential(surface, u, v);
    const r: Vec3 = [target[0] - q.point[0], target[1] - q.point[1], target[2] - q.point[2]];
    if (!(q.det > 1e-30)) break;
    const [a, b] = [dot3(r, q.su), dot3(r, q.sv)];
    u = Math.min(u1, Math.max(u0, u + (q.g * a - q.f * b) / q.det));
    v = Math.min(v1, Math.max(v0, v + (q.e * b - q.f * a) / q.det));
  }
  return [u, v];
}
