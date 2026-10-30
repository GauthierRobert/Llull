/**
 * The silhouette (outline, parting line) of a solid seen along a direction, from its exact faces (03 WRP M5): where the face normal is perpendicular to the direction. Closed forms
 * on the analytic faces: a cylinder gives the two generatrices at +-(axis x direction), a cone the generatrices where cos(alpha) cos(phi - psi) d_p = sin(alpha) (axis . d), a sphere the
 * great circle perpendicular to the direction; a plane has none (it is edge-on or turned toward / away). Each curve is checked against the kernel (the face normals along it are
 * perpendicular to the direction) and only the part inside its face is kept.
 * @invariant every curve returned lies on its face to the kernel's evaluation (points come from `evaluateFace` / are verified by `projectOnFace`), has |n . d| <= 1e-6 along it, and is
 *   strictly inside the face (the faces on both sides of it are the face itself); a silhouette that already is an edge of the solid is reported, not returned
 * @failure torus and freeform faces, a sphere patch the great circle leaves, a face whose silhouette is only partly inside it (a hole), a convention mismatch of the face
 *   parameters -> listed in `unsupported` with the reason
 */

import type { Vec2, Vec3 } from '../../model/vectors';
import { arc2, type NurbsCurve2Data } from '../../lib/nurbs/curve2d';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import type { SurfaceParams } from '../../geometry/kernelPorts';
import type { SolidSession } from './faceSession';

export interface SilhouetteCurve {
  readonly face: number;
  readonly kind: 'line' | 'circle';
  readonly curve: NurbsCurveData;
  /** Pcurve in the kernel's own (u, v) of the face: a polyline through the projected samples. */
  readonly pcurve: NurbsCurve2Data;
  readonly length: number;
}

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
  const at = (fraction: number): Vec2 => [phi, vLow + fraction * span];
  const samples = query.evaluateFace(shape, face, [at(0.1), at(0.9), at(0.5)]);
  if (samples === null) return 'the kernel could not evaluate the face';
  const [first, second, mid] = samples as [(typeof samples)[number], (typeof samples)[number], (typeof samples)[number]];
  const along = (fraction: number): Vec3 => add3(first.point, scale3(sub3(second.point, first.point), (fraction - 0.1) / 0.8));
  const [lo, hi] = [along(0), along(1)];
  const length = len3(sub3(hi, lo));
  if (!(length > 1e-9 * diagonal)) return null;
  const tolerance = 1e-7 * diagonal;
  const contained = query.faceContains(shape, face, mid.point, tolerance);
  if (contained !== true) return null;
  if (Math.abs(dot3(mid.normal, direction)) > 1e-6) return 'the azimuth convention of the face parameters differs from the surface frame';
  // on the seam or on a boundary of the face's u range the silhouette already is an edge
  const turns = (value: number): number => Math.abs(value - TWO_PI * Math.round(value / TWO_PI));
  if (turns(phi - bounds[0][0]) < 1e-9 || turns(phi - bounds[1][0]) < 1e-9) return 'edge';
  const tangent = normalize3(sub3(hi, lo));
  const side = normalize3(cross3(mid.normal, tangent));
  const offset = 1e-3 * diagonal;
  const probes = ([1, -1] as const).map((sign) => add3(mid.point, scale3(side, sign * offset)));
  const snapped = query.projectOnFace(shape, face, probes);
  const inside = snapped?.map((hit) => hit !== null && query.faceContains(shape, face, hit.point, tolerance) === true) ?? [false, false];
  if (!inside.every(Boolean)) return 'edge';
  return { face, kind: 'line', curve: lineCurve(lo, hi), pcurve: polylinePcurve([at(0), at(1)]), length };
}

function sphereCircle(
  session: SolidSession,
  face: number,
  surface: Extract<SurfaceParams, { type: 'sphere' }>,
  direction: Vec3,
): SilhouetteCurve | string {
  const { query, shape, diagonal } = session;
  const d = normalize3(direction);
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
  const uv = hits.map((hit) => (hit as NonNullable<(typeof hits)[number]>).uv);
  return { face, kind: 'circle', curve, pcurve: polylinePcurve([...uv, uv[0] as Vec2]), length: TWO_PI * surface.radius };
}

/** The silhouette curves of the solid's faces seen along `direction`. */
export function silhouettes(session: SolidSession, direction: Vec3): SilhouetteReport {
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
    } else if (surface.type === 'sphere') record(sphereCircle(session, face, surface, d));
    else
      report.unsupported.push({
        face,
        surface: surface.type,
        reason: 'only plane, cylinder, cone and sphere faces have a closed-form silhouette',
      });
  }
  return report;
}
