/**
 * The silhouette of a freeform (B-spline) face seen along a direction (03 WRP M5, TECHNICAL_SPEC §14.16): the contour n . d = 0 of the exact B-spline the kernel gives for the face (`faceQuery.bspline`, the face's own (u, v)).
 * Seeds are the sign changes of G = n . d / |n| on a grid over the parameter box of the face, linked into polylines by marching squares (a cell with four crossings is refused), every crossing is
 * refined to the contour by bisection on its grid edge, the parts of a polyline outside a trimmed face are cut at the boundary by bisection (the contour is re-projected by Newton on F = (S_u x S_v) . d at every step), and
 * each piece is a cubic B-spline fitted through contour points within `tolerance` (the pcurve in the face's own (u, v) likewise), with its deviation reported.
 * @invariant every point of a curve is a point of the exact surface with |n . d| <= 1e-10 |n| (Newton on the exact derivatives) up to the fit deviation, lies in the face (`faceContains`), and the fitted curve is verified against `projectOnFace`
 * @failure no B-spline, a periodic B-spline, a pole (undefined normal), a contour with a cusp or a tangential point (the gradient of n . d vanishes along it) or that Newton cannot follow, a seen-almost-tangentially face
 *   (|n . d| < 1e-3 without a sign change), a fit that misses the tolerance -> a reason string. Features smaller than a cell of the 48 x 48 grid (an island or a fold inside one cell) are not seen
 */

import type { Vec2, Vec3 } from '../../model/vectors';
import { fitBySampling, isMappingError } from '../../geometry/wrapCurves';
import { surfaceOfPort } from '../../geometry/freeformChart';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import { integrateCurve } from '../../lib/nurbs/integrate';
import { interpolatePoints } from '../../lib/nurbs/interpolate';
import { evaluateSurface, surfaceDerivatives, surfaceDomain } from '../../lib/nurbs/surface';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import type { SolidSession } from './faceSession';
import type { SilhouetteCurve } from './silhouetteCurve';

/** Cells per side of the sampling grid over the parameter box of a freeform face (reported as data.silhouette.grid). */
export const FREEFORM_GRID = 48;
const GRID = FREEFORM_GRID;
/** |n . d| under this on every node of the grid: the face is parallel to the view (edge-on). */
const EDGE_ON = 1e-9;
/** |n . d| under this at a node without any sign change in the grid: a tangential view, refused. */
const TANGENTIAL = 1e-3;
/** The gradient of n . d along a contour must not fall under this fraction of its largest value there (a cusp or a branch point otherwise). */
const GRADIENT_FLOOR = 0.05;
/** ...and not under this in absolute terms (a change of n . d over one cell, 1 = the whole range): the contour is then ill-conditioned whatever the rest of the path does. */
const GRADIENT_ABSOLUTE = 1e-4;
const NEWTON_STEPS = 24;
const CONVERGED = 1e-12;
const PROBES = 48;

export interface FreeformContours {
  readonly curves: SilhouetteCurve[];
  readonly onEdge: boolean;
  readonly edgeOn: boolean;
}

interface Path {
  readonly keys: string[];
  readonly closed: boolean;
}

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];

/** Links the segments (pairs of crossing keys) into open paths (from their ends) and closed loops. */
function link(segments: ReadonlyArray<readonly [string, string]>): Path[] {
  const neighbours = new Map<string, string[]>();
  const add = (a: string, b: string): void => void neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
  for (const [a, b] of segments) {
    add(a, b);
    add(b, a);
  }
  const seen = new Set<string>();
  const walk = (start: string): string[] => {
    const keys = [start];
    seen.add(start);
    let current = start;
    for (;;) {
      const next = (neighbours.get(current) ?? []).find((key) => !seen.has(key));
      if (next === undefined) return keys;
      keys.push(next);
      seen.add(next);
      current = next;
    }
  };
  const paths: Path[] = [];
  for (const [key, list] of neighbours) if (list.length === 1 && !seen.has(key)) paths.push({ keys: walk(key), closed: false });
  for (const key of neighbours.keys()) if (!seen.has(key)) paths.push({ keys: walk(key), closed: true });
  return paths;
}

/** A cubic through `sample(k / n)` within `tolerance` (fitBySampling); a closed loop is fitted with the same direction at both ends, so the seam is C1. */
function fitSamples(
  sample: (s: number) => Vec3 | null,
  tolerance: number,
  closed: boolean,
  nullMeaning: string,
): ReturnType<typeof fitBySampling> {
  if (!closed) return fitBySampling(sample, tolerance, nullMeaning);
  const h = 1e-4;
  const [ahead, behind] = [sample(h), sample(1 - h)];
  if (ahead === null || behind === null) return { error: nullMeaning };
  // the derivative per unit s across the seam (central difference), used as it is: the sampler does not run at constant speed
  const tangent = scale3(sub3(ahead, behind), 1 / (2 * h));
  for (let n = 8; n <= 4096; n *= 2) {
    const points: Vec3[] = [];
    for (let k = 0; k <= n; k++) {
      const point = sample(k / n);
      if (point === null) return { error: nullMeaning };
      points.push(point);
    }
    const through = interpolatePoints(points, {
      degree: 3,
      parameterization: 'uniform',
      startTangent: tangent,
      endTangent: tangent,
      exactTangents: true,
    });
    if ('code' in through) return { error: 'a closed curve could not be fitted' };
    let deviation = 0;
    for (let k = 0; k < n; k++)
      for (const fraction of [0.25, 0.5, 0.75]) {
        const exact = sample((k + fraction) / n);
        if (exact === null) return { error: nullMeaning };
        deviation = Math.max(deviation, len3(sub3(evaluateCurve(through.curve, (k + fraction) / n), exact)));
      }
    if (deviation <= tolerance) return { curve: through.curve, deviation };
  }
  return { error: 'a closed curve could not be fitted within the fit tolerance' };
}

/**
 * The contour of the freeform face `face` of `session` seen along `d`, or why it cannot be built.
 * @param bounds the parameter box of the face, [uLow, vLow] and [uHigh, vHigh]
 */
export function freeformContours(
  session: SolidSession,
  face: number,
  bounds: readonly [Vec2, Vec2],
  d: Vec3,
  tolerance: number,
): FreeformContours | string {
  const { query, shape, diagonal } = session;
  const port = query.bspline(shape, face);
  if (port === null) return 'the kernel gave no exact B-spline for this freeform face';
  if (port.periodicU || port.periodicV)
    return 'the B-spline of this face is periodic (a closed freeform surface): split the face with a plane first, or use an open patch';
  const surface = surfaceOfPort(port);
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const lo: Vec2 = [Math.max(bounds[0][0], u0), Math.max(bounds[0][1], v0)];
  const hi: Vec2 = [Math.min(bounds[1][0], u1), Math.min(bounds[1][1], v1)];
  if (!(hi[0] > lo[0] && hi[1] > lo[1])) return 'the parameter box of the face lies outside its B-spline';
  const dir = normalize3(d);
  const cell = Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / GRID;
  const area = diagonal * diagonal;
  const clamp = (uv: Vec2): Vec2 => [Math.min(hi[0], Math.max(lo[0], uv[0])), Math.min(hi[1], Math.max(lo[1], uv[1]))];

  const valueAt = (uv: Vec2): number | null => {
    const ds = surfaceDerivatives(surface, uv[0], uv[1], 1);
    const n = cross3((ds[1] as Vec3[])[0] as Vec3, (ds[0] as Vec3[])[1] as Vec3);
    const length = len3(n);
    if (!(length > 1e-12 * area)) return null;
    return dot3(n, dir) / length;
  };
  /** F = n . d with its gradient in (u, v), and |n| (n = S_u x S_v). */
  const field = (uv: Vec2): { f: number; fu: number; fv: number; length: number } => {
    const ds = surfaceDerivatives(surface, uv[0], uv[1], 2);
    const at = (k: number, l: number): Vec3 => ((ds[k] as Vec3[])[l] as Vec3) ?? [0, 0, 0];
    const [su, sv] = [at(1, 0), at(0, 1)];
    const n = cross3(su, sv);
    return {
      f: dot3(n, dir),
      fu: dot3(add3(cross3(at(2, 0), sv), cross3(su, at(1, 1))), dir),
      fv: dot3(add3(cross3(at(1, 1), sv), cross3(su, at(0, 2))), dir),
      length: len3(n),
    };
  };
  /** Newton projection of `uv` onto F = 0 (steps along the gradient); null when it does not converge inside the box. */
  const project = (start: Vec2): Vec2 | null => {
    let uv = start;
    for (let step = 0; step < NEWTON_STEPS; step++) {
      const { f, fu, fv, length } = field(uv);
      if (!(length > 1e-12 * area)) return null;
      if (Math.abs(f) / length < CONVERGED) return uv;
      const slope = fu * fu + fv * fv;
      if (!(slope > 0)) return null;
      const next = clamp([uv[0] - (f * fu) / slope, uv[1] - (f * fv) / slope]);
      if (Math.hypot(next[0] - uv[0], next[1] - uv[1]) > 2 * cell) return null;
      uv = next;
    }
    const last = field(uv);
    return Math.abs(last.f) / last.length < 1e-9 ? uv : null;
  };

  // the grid
  const node = (i: number, j: number): Vec2 => [lo[0] + ((hi[0] - lo[0]) * i) / GRID, lo[1] + ((hi[1] - lo[1]) * j) / GRID];
  const values: number[] = [];
  for (let j = 0; j <= GRID; j++)
    for (let i = 0; i <= GRID; i++) {
      const g = valueAt(node(i, j));
      if (g === null) return 'the face has a pole or a collapsed edge where its normal is undefined: split the face away from it first';
      values.push(g);
    }
  const at = (i: number, j: number): number => values[j * (GRID + 1) + i] as number;
  if (values.every((g) => Math.abs(g) < EDGE_ON)) return { curves: [], onEdge: false, edgeOn: true };
  const positive = (g: number): boolean => g >= 0;
  if (values.every(positive) || values.every((g) => !positive(g))) {
    return Math.min(...values.map(Math.abs)) < TANGENTIAL
      ? `the face is seen almost tangentially (|n . d| is under ${TANGENTIAL} without changing sign): the contour would be a double root that cannot be traced; turn the direction a little`
      : { curves: [], onEdge: false, edgeOn: false };
  }

  // marching squares: a crossing sits on a grid edge (key `a-b` of the node numbers), refined by bisection
  const crossings = new Map<string, Vec2>();
  const crossing = (i0: number, j0: number, i1: number, j1: number): string => {
    const [a, b] = [j0 * (GRID + 1) + i0, j1 * (GRID + 1) + i1];
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (!crossings.has(key)) {
      const [p, q] = [node(i0, j0), node(i1, j1)];
      let [s0, s1] = [0, 1];
      const sign = positive(at(i0, j0));
      for (let step = 0; step < 60; step++) {
        const middle = (s0 + s1) / 2;
        const g = valueAt(lerp(p, q, middle));
        if (g !== null && positive(g) === sign) s0 = middle;
        else s1 = middle;
      }
      crossings.set(key, lerp(p, q, (s0 + s1) / 2));
    }
    return key;
  };
  const segments: Array<readonly [string, string]> = [];
  let branch = false;
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const corners: ReadonlyArray<readonly [number, number]> = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const signs = corners.map(([ci, cj]) => positive(at(ci, cj)));
      const cut = [0, 1, 2, 3].filter((k) => signs[k] !== signs[(k + 1) % 4]);
      if (cut.length === 0) continue;
      const edge = (k: number): string => {
        const [a, b] = [corners[k] as readonly [number, number], corners[(k + 1) % 4] as readonly [number, number]];
        return crossing(a[0], a[1], b[0], b[1]);
      };
      if (cut.length === 2) segments.push([edge(cut[0] as number), edge(cut[1] as number)]);
      else {
        // a saddle cell (two branches of the contour inside one cell, or a branch point): refused, the pairing of the crossings would be a guess
        branch = true;
      }
    }

  if (branch)
    return 'the contour has a branch point or two branches closer than a cell of the sampling grid (the pairing of its crossings would be a guess): turn the direction a little';
  const tolerancePoint = Math.max(1e-7 * diagonal, 0);
  const inside = (uv: Vec2): boolean => query.faceContains(shape, face, evaluateSurface(surface, uv[0], uv[1]), tolerancePoint) === true;
  const buildCurve = (run: readonly Vec2[]): SilhouetteCurve | 'edge' | string => {
    const points = run.map((uv) => evaluateSurface(surface, uv[0], uv[1]));
    const total = points.reduce((sum, point, k) => (k === 0 ? 0 : sum + len3(sub3(point, points[k - 1] as Vec3))), 0);
    if (!(total > 1e-9 * diagonal)) return 'edge';
    // vertices closer than a third of a cell are dropped (they make the interpolation ill-conditioned; the projection restores the exactness), the two ends are kept
    const separate: Vec2[] = [];
    run.forEach((uv, k) => {
      const previous = separate.at(-1);
      if (previous !== undefined && Math.hypot(uv[0] - previous[0], uv[1] - previous[1]) <= cell / 3) {
        if (k === run.length - 1) separate[separate.length - 1] = uv;
      } else separate.push(uv);
    });
    const head = separate[0] as Vec2;
    const tail = separate.at(-1) as Vec2;
    const closed = separate.length > 5 && Math.hypot(head[0] - tail[0], head[1] - tail[1]) <= 1e-6 * cell;
    // the sampler must be smooth for the fit to converge: an interpolating cubic through the refined vertices (a closed loop over a ring extended by three points on each side, read over one turn),
    // projected back onto the contour at every evaluation
    const ring = closed ? separate.slice(0, -1) : separate;
    const extended = closed ? [...ring.slice(-3), ...ring, ...ring.slice(0, 4)] : ring;
    const lifted = extended.map((uv): Vec3 => [uv[0], uv[1], 0]);
    const through = interpolatePoints(lifted, { degree: 3, parameterization: 'chord' });
    if ('code' in through) return 'the contour of the freeform face cannot be interpolated';
    const chords = lifted
      .slice(1)
      .reduce<number[]>((sum, point, k) => [...sum, (sum[k] as number) + len3(sub3(point, lifted[k] as Vec3))], [0]);
    const [tStart, tEnd] = closed
      ? [(chords[3] as number) / (chords.at(-1) as number), (chords[3 + ring.length] as number) / (chords.at(-1) as number)]
      : [0, 1];
    /** The contour point at s in [0, 1], or null when Newton cannot bring the interpolated point back onto it. */
    const uvAt = (s: number): Vec2 | null => {
      const point = evaluateCurve(through.curve, tStart + s * (tEnd - tStart));
      return project(clamp([point[0], point[1]]));
    };
    const lost =
      'Newton cannot follow the contour of the freeform face (the interpolated silhouette cannot be projected back onto n . d = 0): turn the direction a little';
    const fitted = fitSamples(
      (s) => {
        const uv = uvAt(s);
        return uv === null ? null : evaluateSurface(surface, uv[0], uv[1]);
      },
      tolerance,
      closed,
      lost,
    );
    if (isMappingError(fitted)) return fitted.error;
    const speeds = Array.from({ length: 97 }, (_, k) => uvAt(k / 96)).map((uv) => {
      if (uv === null) return Infinity;
      const ds = surfaceDerivatives(surface, uv[0], uv[1], 1);
      return Math.hypot(len3((ds[1] as Vec3[])[0] as Vec3), len3((ds[0] as Vec3[])[1] as Vec3));
    });
    const speed = Math.max(...speeds);
    if (!Number.isFinite(speed)) return lost;
    const parametric = fitSamples(
      (s) => {
        const uv = uvAt(s);
        return uv === null ? null : ([uv[0], uv[1], 0] as Vec3);
      },
      tolerance / speed,
      closed,
      lost,
    );
    if (isMappingError(parametric)) return parametric.error;
    const [first, last] = curveDomain(fitted.curve);
    const at = (k: number): number => first + ((k + 0.37) / PROBES) * (last - first);
    const probes = Array.from({ length: PROBES }, (_, k) => evaluateCurve(fitted.curve, at(k)));
    const hits = query.projectOnFace(shape, face, probes);
    const slack = 2 * tolerance + 1e-7 * diagonal;
    if (
      hits === null ||
      !hits.every((hit, k) => hit !== null && hit.distance < slack && query.faceContains(shape, face, probes[k] as Vec3, slack) === true)
    )
      return 'the fitted silhouette leaves the face (the kernel does not project it back within the tolerance)';
    // the fit must lie on the contour, not only on the surface: the distance of the fitted pcurve to n . d = 0 (|F| / |grad F| in the parameter plane, times the surface speed)
    for (let k = 0; k < PROBES; k++) {
      const uv = evaluateCurve(parametric.curve, at(k));
      const { f, fu, fv } = field([uv[0], uv[1]]);
      if (!((Math.abs(f) / Math.hypot(fu, fv)) * speed <= slack))
        return 'the fitted silhouette does not lie on the contour n . d = 0 within the tolerance (the interpolated contour was not followed)';
    }
    // a contour along a boundary of the face already is an edge of the solid: both sides of the middle must be face
    const [middle, ahead, behind] = [uvAt(0.5), uvAt(0.51), uvAt(0.49)];
    if (middle === null || ahead === null || behind === null) return lost;
    const [before, after] = [behind, ahead].map((uv) => evaluateSurface(surface, uv[0], uv[1])) as [Vec3, Vec3];
    const normal = query.evaluateFace(shape, face, [middle])?.[0]?.normal;
    const centre = evaluateSurface(surface, middle[0], middle[1]);
    if (normal !== undefined && len3(sub3(after, before)) > 0) {
      const side = normalize3(cross3(normal, sub3(after, before)));
      const snapped = query.projectOnFace(shape, face, [
        add3(centre, scale3(side, 1e-3 * diagonal)),
        sub3(centre, scale3(side, 1e-3 * diagonal)),
      ]);
      if (!(snapped?.every((hit) => hit !== null && query.faceContains(shape, face, hit.point, tolerancePoint) === true) ?? false))
        return 'edge';
    }
    return {
      face,
      kind: 'fitted',
      curve: fitted.curve,
      pcurve: { ...parametric.curve, poles: parametric.curve.poles.map(([u, v]): Vec2 => [u, v]) },
      length: integrateCurve(fitted.curve, first, last, (_point, derivative) => Math.hypot(derivative[0], derivative[1], derivative[2])),
      deviation: Math.max(fitted.deviation, parametric.deviation * speed),
    };
  };

  const curves: SilhouetteCurve[] = [];
  let onEdge = false;
  for (const path of link(segments)) {
    const refined: Vec2[] = [];
    const gradients: number[] = [];
    for (const key of path.keys) {
      const projected = project(crossings.get(key) as Vec2);
      if (projected === null)
        return 'the contour has a cusp or a branch point (the gradient of n . d vanishes there) or Newton cannot follow it: turn the direction a little';
      refined.push(projected);
      const { fu, fv, length } = field(projected);
      gradients.push((Math.hypot(fu, fv) * cell) / length);
    }
    // the gradient also at the middle of every step: a branch point between two vertices shows there
    for (let k = 1; k < refined.length; k++) {
      const [p, q] = [refined[k - 1] as Vec2, refined[k] as Vec2];
      const { fu, fv, length } = field([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      gradients.push((Math.hypot(fu, fv) * cell) / length);
    }
    if (Math.min(...gradients) < GRADIENT_FLOOR * Math.max(...gradients) || Math.min(...gradients) < GRADIENT_ABSOLUTE)
      return 'the contour has a cusp or is tangential to the view somewhere (the gradient of n . d vanishes along it): turn the direction a little';
    const ring = path.closed ? [...refined, refined[0] as Vec2] : refined;
    for (const run of insideRuns(ring, path.closed, inside, project)) {
      const built = buildCurve(run);
      if (built === 'edge') onEdge = true;
      else if (typeof built === 'string') return built;
      else curves.push(built);
    }
  }
  return { curves, onEdge, edgeOn: false };
}

/**
 * The pieces of a refined polyline (`ring`, first point repeated at the end when closed) that lie inside the face, each cut at the boundary by bisection. A closed polyline wholly inside stays closed
 * (first point repeated); one cut by the boundary is rotated to start outside, so every run is open.
 */
function insideRuns(ring: readonly Vec2[], closed: boolean, inside: (uv: Vec2) => boolean, project: (uv: Vec2) => Vec2 | null): Vec2[][] {
  const flags = ring.map(inside);
  if (flags.every(Boolean)) return [[...ring]];
  const body = closed ? ring.slice(0, -1) : [...ring];
  const bodyFlags = closed ? flags.slice(0, -1) : [...flags];
  let start = 0;
  if (closed) start = bodyFlags.indexOf(false);
  const count = body.length;
  const order = Array.from({ length: count }, (_, k) => (start + k) % count);
  const cutAt = (good: Vec2, bad: Vec2): Vec2 => {
    let [s0, s1] = [0, 1];
    let best = good;
    for (let step = 0; step < 50; step++) {
      const middle = (s0 + s1) / 2;
      const raw = lerp(good, bad, middle);
      const uv = project(raw);
      if (uv !== null && inside(uv)) {
        s0 = middle;
        best = uv;
      } else s1 = middle;
    }
    return best;
  };
  const runs: Vec2[][] = [];
  let current: Vec2[] = [];
  const flush = (): void => {
    if (current.length >= 2) runs.push(current);
    current = [];
  };
  order.forEach((index, position) => {
    const uv = body[index] as Vec2;
    if (bodyFlags[index] === true) {
      if (current.length === 0 && position > 0) {
        const previous = body[order[position - 1] as number] as Vec2;
        current.push(cutAt(uv, previous));
      }
      current.push(uv);
      const nextIndex = order[position + 1];
      if (nextIndex === undefined) {
        if (closed) current.push(cutAt(uv, body[order[0] as number] as Vec2));
        flush();
      } else if (bodyFlags[nextIndex] !== true) {
        current.push(cutAt(uv, body[nextIndex] as Vec2));
        flush();
      }
    }
  });
  return runs;
}
