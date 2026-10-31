/**
 * The silhouette (outline, parting line) of a solid seen along a direction, from its exact faces (03 WRP M5): where the face normal is perpendicular to the direction. Closed forms
 * on the analytic faces: a cylinder gives the two generatrices at +-(axis x direction), a cone the generatrices where cos(alpha) cos(phi - psi) d_p = sin(alpha) (axis . d), a sphere the
 * great circle perpendicular to the direction, a torus (axis a, d = d_a a + d_p) the two closed curves v = atan(-d_p cos u / d_a) + k pi (u from the direction of d_p; atan, not atan2, so v is continuous for either sign of d_a); a plane has none (it is edge-on or turned toward / away). Each curve is checked against the kernel (the face normals along it are
 * perpendicular to the direction) and only the part inside its face is kept.
 * @invariant every curve returned lies on its face to the kernel's evaluation (points come from `evaluateFace` / are verified by `projectOnFace`), has |n . d| <= 1e-6 along it, and is
 *   strictly inside the face (the faces on both sides of it are the face itself); a silhouette that already is an edge of the solid is reported, not returned
 * @failure a freeform face with a cusp, a branch point, a pole, a periodic B-spline or a tangential view (freeformSilhouette.ts), a torus seen along its equatorial plane (four crossing circles), a torus whose frame the kernel parametrises differently, a torus or sphere patch the contour leaves, a face whose silhouette is only partly inside it (a hole), a convention mismatch of the face
 *   parameters -> listed in `unsupported` with the reason
 */

import type { Vec2, Vec3 } from '../../model/vectors';
import { arc2, type NurbsCurve2Data } from '../../lib/nurbs/curve2d';
import { fitBySampling, isMappingError } from '../../geometry/wrapCurves';
import { curveDomain } from '../../lib/nurbs/evaluate';
import { integrateCurve } from '../../lib/nurbs/integrate';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import type { SurfaceParams } from '../../geometry/kernelPorts';
import type { SolidSession } from './faceSession';
import { freeformContours } from './freeformSilhouette';
import type { SilhouetteCurve } from './silhouetteCurve';
import { continuousUv } from './splitChains';

export interface SilhouetteReport {
  readonly curves: SilhouetteCurve[];
  /** Faces parallel to the direction (their normals are perpendicular to it everywhere): the parting line is their boundary. */
  readonly edgeOn: number[];
  /** Faces whose silhouette is already an edge of the solid (nothing to split). */
  readonly onEdge: number[];
  readonly unsupported: Array<{ readonly face: number; readonly surface: string; readonly reason: string }>;
}

const TWO_PI = 2 * Math.PI;
const SAMPLES = 24;

function lineCurve(a: Vec3, b: Vec3): NurbsCurveData {
  return { degree: 1, poles: [a, b], knots: [0, 1], multiplicities: [2, 2] };
}

/** The polyline through `uv` as a degree-1 curve of the parameter plane. */
function polylinePcurve(uv: readonly Vec2[]): NurbsCurve2Data {
  const count = uv.length;
  return {
    degree: 1,
    poles: uv,
    knots: Array.from({ length: count }, (_, k) => k / (count - 1)),
    multiplicities: Array.from({ length: count }, (_, k) => (k === 0 || k === count - 1 ? 2 : 1)),
  };
}

const frameOf = (axis: Vec3, xDir: Vec3): { a: Vec3; x: Vec3; y: Vec3 } => {
  const a = normalize3(axis);
  const x = normalize3(sub3(xDir, scale3(a, dot3(xDir, a))));
  return { a, x, y: cross3(a, x) };
};

/** `bounds` of the face as [uLow, vLow], [uHigh, vHigh]; the generatrix at azimuth `phi` as a line between the face's v extremes, or null when it is not on the face. */
function generatrix(
  session: SolidSession,
  face: number,
  phi: number,
  bounds: readonly [Vec2, Vec2],
  direction: Vec3,
): SilhouetteCurve | 'edge' | string | null {
  const { query, shape, diagonal } = session;
  // the generatrix is straight and linear in v: two interior samples give its ends exactly (a cone's apex end cannot be evaluated)
  const [vLow, vHigh] = [bounds[0][1], bounds[1][1]];
  const span = vHigh - vLow;
  // the parameter plane's own turn of the azimuth (a pcurve in the face's u range), the same line
  const azimuth = bounds[0][0] + ((((phi - bounds[0][0]) % TWO_PI) + TWO_PI) % TWO_PI);
  const at = (fraction: number): Vec2 => [azimuth, vLow + fraction * span];
  const samples = query.evaluateFace(shape, face, [at(0.1), at(0.9), at(0.5)]);
  if (samples === null) return 'the kernel could not evaluate the face';
  const [first, second, mid] = samples as [(typeof samples)[number], (typeof samples)[number], (typeof samples)[number]];
  const along = (fraction: number): Vec3 => add3(first.point, scale3(sub3(second.point, first.point), (fraction - 0.1) / 0.8));
  const [full0, full1] = [along(0), along(1)];
  if (!(len3(sub3(full1, full0)) > 1e-9 * diagonal)) return null;
  const tolerance = 1e-7 * diagonal;
  const contained = query.faceContains(shape, face, mid.point, tolerance);
  if (contained !== true) return null;
  if (Math.abs(dot3(mid.normal, direction)) > 1e-6) return 'the azimuth convention of the face parameters differs from the surface frame';
  // on the seam or on a boundary of the face's u range the silhouette already is an edge
  const turns = (value: number): number => Math.abs(value - TWO_PI * Math.round(value / TWO_PI));
  if (turns(phi - bounds[0][0]) < 1e-9 || turns(phi - bounds[1][0]) < 1e-9) return 'edge';
  // the part of the line inside the face (a tilted or curved boundary cuts the generatrix short of the v extremes): bisect from the middle
  const pointAt = (t: number): Vec3 => add3(full0, scale3(sub3(full1, full0), t));
  const reaches = (t: number): boolean => query.faceContains(shape, face, pointAt(t), tolerance) === true;
  const boundary = (outer: number): number => {
    if (reaches(outer)) return outer;
    let [bad, good] = [outer, 0.5];
    for (let step = 0; step < 50; step++) {
      const middle = (bad + good) / 2;
      if (reaches(middle)) good = middle;
      else bad = middle;
    }
    return good;
  };
  const [t0, t1] = [boundary(0), boundary(1)];
  const [lo, hi] = [pointAt(t0), pointAt(t1)];
  const length = len3(sub3(hi, lo));
  if (!(length > 1e-9 * diagonal)) return null;
  const tangent = normalize3(sub3(hi, lo));
  const side = normalize3(cross3(mid.normal, tangent));
  const offset = 1e-3 * diagonal;
  const probes = ([1, -1] as const).map((sign) => add3(mid.point, scale3(side, sign * offset)));
  const snapped = query.projectOnFace(shape, face, probes);
  const inside = snapped?.map((hit) => hit !== null && query.faceContains(shape, face, hit.point, tolerance) === true) ?? [false, false];
  if (!inside.every(Boolean)) return 'edge';
  return { face, kind: 'line', curve: lineCurve(lo, hi), pcurve: polylinePcurve([at(t0), at(t1)]), length, deviation: 0 };
}

function sphereCircle(
  session: SolidSession,
  face: number,
  surface: Extract<SurfaceParams, { type: 'sphere' }>,
  bounds: readonly [Vec2, Vec2],
  direction: Vec3,
): SilhouetteCurve | string {
  const { query, shape, diagonal } = session;
  const d = normalize3(direction);
  // a great circle through the poles runs along the seam or through the singular points of the parameters: refused by reason
  const pole = query.evaluateFace(shape, face, [[bounds[0][0], bounds[1][1]]])?.[0];
  if (pole !== undefined && Math.abs(dot3(sub3(pole.point, surface.center), d)) < 1e-6 * surface.radius)
    return 'the great circle passes through the poles of the sphere face, where its parameters are singular (and along its seam): turn the direction off the sphere axis, or split the sphere with a plane first';
  const helper: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize3(cross3(d, helper));
  const e2 = cross3(d, e1);
  const circle = arc2([0, 0], surface.radius, 0, TWO_PI);
  const curve: NurbsCurveData = {
    degree: circle.degree,
    poles: circle.poles.map(([x, y]) => add3(surface.center, add3(scale3(e1, x), scale3(e2, y)))),
    ...(circle.weights === undefined ? {} : { weights: [...circle.weights] }),
    knots: [...circle.knots],
    multiplicities: [...circle.multiplicities],
  };
  const points = Array.from({ length: SAMPLES }, (_, k): Vec3 => {
    const angle = (TWO_PI * k) / SAMPLES;
    return add3(surface.center, add3(scale3(e1, surface.radius * Math.cos(angle)), scale3(e2, surface.radius * Math.sin(angle))));
  });
  const hits = query.projectOnFace(shape, face, points);
  if (hits === null) return 'the kernel could not project the great circle onto the face';
  if (
    !hits.every(
      (hit) => hit !== null && hit.distance < 1e-7 * diagonal && query.faceContains(shape, face, hit.point, 1e-7 * diagonal) === true,
    )
  )
    return 'the great circle leaves this sphere patch';
  const raw = hits.map((hit) => (hit as NonNullable<(typeof hits)[number]>).uv);
  const continued = continuousUv([...raw, raw[0] as Vec2], [true, false]);
  const turn = TWO_PI * Math.floor(((continued[0] as Vec2)[0] - bounds[0][0]) / TWO_PI);
  const uv = continued.map(([u, v]): Vec2 => [u - turn, v]);
  return { face, kind: 'circle', curve, pcurve: polylinePcurve(uv), length: TWO_PI * surface.radius, deviation: 0 };
}

const TORUS_PROBES = 48;
const wrapPi = (angle: number): number => angle - TWO_PI * Math.round(angle / TWO_PI);

/**
 * The two contour curves of a torus seen along `d` (see the module comment), as fitted cubic B-splines within `tolerance` with their pcurves in the kernel's own (u, v). The kernel's frame is
 * read from three evaluations of the face (its azimuth origin and the direction of its axis), and the whole contour is verified against `evaluateFace`, `projectOnFace` and `faceContains`.
 */
function torusContours(
  session: SolidSession,
  face: number,
  surface: Extract<SurfaceParams, { type: 'torus' }>,
  bounds: readonly [Vec2, Vec2],
  d: Vec3,
  tolerance: number,
): { readonly curves: SilhouetteCurve[]; readonly onEdge: boolean } | string {
  const { query, shape, diagonal } = session;
  const { center, major: R, minor: r } = surface;
  const a = normalize3(surface.axis);
  const da = dot3(d, a);
  const perp = sub3(d, scale3(a, da));
  const dp = len3(perp);
  if (Math.abs(da) < 1e-9 * len3(d))
    return 'seen along its equatorial plane a torus has four crossing contour circles (two parallels and two meridians): tilt the direction off the plane of the torus, or split the torus with a plane first';
  const x = dp > 1e-12 ? scale3(perp, 1 / dp) : frameOf(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]).x;
  const y = cross3(a, x);
  const probe = query.evaluateFace(shape, face, [
    [0, 0],
    [Math.PI / 2, 0],
    [0, Math.PI / 2],
  ]);
  if (probe === null) return 'the kernel could not evaluate the torus face';
  const [p00, p10, p01] = probe.map((hit) => sub3(hit.point, center)) as [Vec3, Vec3, Vec3];
  const kx = normalize3(sub3(p00, scale3(a, dot3(p00, a))));
  const ky = normalize3(sub3(p10, scale3(a, dot3(p10, a))));
  const ka = scale3(sub3(p01, scale3(kx, R)), 1 / r);
  const sigmaV = dot3(ka, a) >= 0 ? 1 : -1;
  const theta0 = Math.atan2(dot3(x, ky), dot3(x, kx));
  const sigmaU = wrapPi(Math.atan2(dot3(y, ky), dot3(y, kx)) - theta0) >= 0 ? 1 : -1;
  const point = (u: number, v: number): Vec3 =>
    add3(add3(center, scale3(add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u))), R + r * Math.cos(v))), scale3(a, r * Math.sin(v)));
  const contourV = (u: number, branch: number): number => Math.atan(-(dp * Math.cos(u)) / da) + branch * Math.PI;
  const turnU = TWO_PI * Math.floor((theta0 - bounds[0][0]) / TWO_PI);
  const kernelUv = (s: number, branch: number): Vec2 => {
    const v = sigmaV * contourV(TWO_PI * s, branch);
    return [theta0 + sigmaU * TWO_PI * s - turnU, v - TWO_PI * Math.floor((sigmaV * contourV(0, branch) - bounds[0][1]) / TWO_PI)];
  };
  const out: SilhouetteCurve[] = [];
  let onEdge = false;
  for (const branch of [0, 1]) {
    // along the axis a contour is a parallel (constant v): the outer equator is the seam of the face, already an edge
    const seam = (value: number): boolean => Math.abs(wrapPi(value)) < 1e-9;
    if (dp <= 1e-12 && (seam(sigmaV * contourV(0, branch) - bounds[0][1]) || seam(sigmaV * contourV(0, branch) - bounds[1][1]))) {
      onEdge = true;
      continue;
    }
    const checks = Array.from({ length: TORUS_PROBES }, (_, k) => (k + 0.37) / TORUS_PROBES);
    const exact = checks.map((s) => point(TWO_PI * s, contourV(TWO_PI * s, branch)));
    const evaluated = query.evaluateFace(
      shape,
      face,
      checks.map((s) => kernelUv(s, branch)),
    );
    if (
      evaluated === null ||
      !evaluated.every(
        (hit, k) => len3(sub3(hit.point, exact[k] as Vec3)) < 1e-7 * diagonal && Math.abs(dot3(hit.normal, d)) < 1e-6 * len3(d),
      )
    )
      return 'the parameter convention of the torus face differs from its surface frame';
    const hits = query.projectOnFace(shape, face, exact);
    if (
      hits === null ||
      !hits.every(
        (hit) => hit !== null && hit.distance < 1e-7 * diagonal && query.faceContains(shape, face, hit.point, 1e-7 * diagonal) === true,
      )
    )
      return 'the contour of the torus leaves this torus patch';
    const curve = fitBySampling((s) => point(TWO_PI * s, contourV(TWO_PI * s, branch)), tolerance, 'the torus contour cannot be fitted');
    if (isMappingError(curve)) return curve.error;
    const pcurve = fitBySampling((s) => [...kernelUv(s, branch), 0] as Vec3, tolerance / (R + r), 'the torus contour cannot be fitted');
    if (isMappingError(pcurve)) return pcurve.error;
    const [first, last] = curveDomain(curve.curve);
    out.push({
      face,
      kind: 'fitted',
      curve: curve.curve,
      pcurve: { ...pcurve.curve, poles: pcurve.curve.poles.map(([u, v]): Vec2 => [u, v]) },
      length: integrateCurve(curve.curve, first, last, (_point, derivative) => Math.hypot(derivative[0], derivative[1], derivative[2])),
      deviation: Math.max(curve.deviation, pcurve.deviation * (R + r)),
    });
  }
  return { curves: out, onEdge };
}

/** The silhouette curves of the solid's faces seen along `direction`; `tolerance` (document units) is the fit of the torus contours. */
export function silhouettes(session: SolidSession, direction: Vec3, tolerance = 1e-6 * session.diagonal): SilhouetteReport {
  const d = normalize3(direction);
  const report: SilhouetteReport = { curves: [], edgeOn: [], onEdge: [], unsupported: [] };
  const faces = session.topology?.faces.length ?? 0;
  for (let face = 0; face < faces; face++) {
    const geometry = session.query.faceGeometry(session.shape, face);
    if (geometry === null) {
      report.unsupported.push({ face, surface: 'unknown', reason: 'the kernel gave no exact geometry' });
      continue;
    }
    const { surface, uvBounds } = geometry;
    const record = (found: SilhouetteCurve | 'edge' | string | null): void => {
      if (found === null) return;
      if (found === 'edge') {
        if (!report.onEdge.includes(face)) report.onEdge.push(face);
      } else if (typeof found === 'string') report.unsupported.push({ face, surface: surface.type, reason: found });
      else report.curves.push(found);
    };
    if (surface.type === 'plane') {
      if (Math.abs(dot3(normalize3(surface.normal), d)) < 1e-9) report.edgeOn.push(face);
    } else if (surface.type === 'cylinder') {
      const { a, x, y } = frameOf(surface.axis, surface.xDir);
      const across = cross3(a, d);
      if (len3(across) < 1e-9) {
        report.edgeOn.push(face);
        continue;
      }
      const n = normalize3(across);
      for (const sign of [1, -1]) record(generatrix(session, face, Math.atan2(sign * dot3(n, y), sign * dot3(n, x)), uvBounds, d));
    } else if (surface.type === 'cone') {
      const { a, x, y } = frameOf(surface.axis, surface.xDir);
      const dPerp = sub3(d, scale3(a, dot3(d, a)));
      const dp = len3(dPerp);
      const ratio = dp < 1e-12 ? Infinity : (Math.tan(surface.semiAngle) * dot3(d, a)) / dp;
      if (!(Math.abs(ratio) < 1 - 1e-12)) continue;
      const psi = Math.atan2(dot3(dPerp, y), dot3(dPerp, x));
      const spread = Math.acos(ratio);
      for (const sign of [1, -1]) record(generatrix(session, face, psi + sign * spread, uvBounds, d));
    } else if (surface.type === 'sphere') record(sphereCircle(session, face, surface, uvBounds, d));
    else if (surface.type === 'torus') {
      const found = torusContours(session, face, surface, uvBounds, d, tolerance);
      if (typeof found === 'string') report.unsupported.push({ face, surface: 'torus', reason: found });
      else {
        report.curves.push(...found.curves);
        if (found.onEdge && !report.onEdge.includes(face)) report.onEdge.push(face);
      }
    } else if (surface.type === 'other' && surface.kind === 'bspline') {
      const found = freeformContours(session, face, uvBounds, d, tolerance);
      if (typeof found === 'string') report.unsupported.push({ face, surface: 'bspline', reason: found });
      else {
        report.curves.push(...found.curves);
        if (found.edgeOn) report.edgeOn.push(face);
        if (found.onEdge && !report.onEdge.includes(face)) report.onEdge.push(face);
      }
    } else
      report.unsupported.push({
        face,
        surface: surface.type,
        reason: 'only plane, cylinder, cone, sphere, torus and B-spline faces have a silhouette',
      });
  }
  return report;
}
