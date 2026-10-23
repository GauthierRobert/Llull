/** Section preparation of an advanced loft: winding about the direction of travel, seam alignment (exact re-seaming) and centreline-placed intermediates. */

import type { Vec3 } from '../../model/vectors';
import { add3, cross3, distance3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { reverseCurve } from '../../lib/nurbs/edit';
import { curveDerivatives, curveDomain, evaluateCurve, sampleCurve } from '../../lib/nurbs/evaluate';
import { parameterAtLengthFraction } from '../../lib/nurbs/curveSplit';
import { isClosedCurve, nearestParameter, reseamCurve } from '../../lib/nurbs/reseam';
import { wireCentroid } from '../../lib/nurbs/skinEnds';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { LoftIssue } from './types';

/** Unit normal of the best plane of a section (Newell's method on 64 samples), sign following the curve's winding. */
export function sectionNormal(curve: NurbsCurveData): Vec3 {
  const ring = sampleCurve(curve, 65).slice(0, -1);
  let normal: Vec3 = [0, 0, 0];
  ring.forEach((p, i) => (normal = add3(normal, cross3(p, ring[(i + 1) % ring.length] as Vec3))));
  return normalize3(normal);
}

/** The sections wound alike about the direction of travel (centroid to centroid): a section whose normal opposes it is reversed. */
export function windSections(curves: readonly NurbsCurveData[]): NurbsCurveData[] {
  const centroids = curves.map(wireCentroid);
  return curves.map((curve, i) => {
    const travel = sub3(centroids[Math.min(i + 1, curves.length - 1)] as Vec3, centroids[Math.max(i - 1, 0)] as Vec3);
    return dot3(sectionNormal(curve), travel) >= 0 ? curve : reverseCurve(curve);
  });
}

/** Minimal rotation taking the unit vector `a` to the unit vector `b`, as a function on vectors (Rodrigues). */
function rotationBetween(a: Vec3, b: Vec3): (v: Vec3) => Vec3 {
  const axis = cross3(a, b);
  const sine = len3(axis);
  const cosine = dot3(a, b);
  // sections are wound toward the travel, so their normals never oppose: parallel normals need no rotation
  if (sine < 1e-12) return (v) => v;
  const k = scale3(axis, 1 / sine);
  return (v) => add3(add3(scale3(v, cosine), scale3(cross3(k, v), sine)), scale3(k, dot3(k, v) * (1 - cosine)));
}

/**
 * Seams of closed sections moved by exact re-seaming. `auto`: each section starts at the point nearest to the previous section's start
 * (carried over by the translation and the minimal rotation between their planes); `seams`: at the given parameter fractions.
 * @failure a failing knot insertion -> LoftIssue
 */
export function alignSections(
  curves: readonly NurbsCurveData[],
  mode: 'auto' | 'none' | 'seams',
  seams: readonly number[] | undefined,
  closed = false,
): NurbsCurveData[] | LoftIssue {
  if (mode === 'none') return [...curves];
  const out: NurbsCurveData[] = [];
  for (const [i, curve] of curves.entries()) {
    let seam: number | null = null;
    if (!isClosedCurve(curve)) seam = null;
    else if (mode === 'seams') {
      const [a, b] = curveDomain(curve);
      const fraction = seams?.[i] ?? 0;
      seam = a + (b - a) * fraction;
    } else if (i > 0) {
      const previous = out[i - 1] as NurbsCurveData;
      const [centreA, centreB] = [wireCentroid(previous), wireCentroid(curve)];
      const rotate = rotationBetween(sectionNormal(previous), sectionNormal(curve));
      const startOffset = sub3(evaluateCurve(previous, curveDomain(previous)[0]), centreA);
      seam = nearestParameter(curve, add3(centreB, rotate(startOffset)));
    }
    if (seam === null) {
      out.push(curve);
      continue;
    }
    const moved = reseamCurve(curve, seam);
    if (typeof moved === 'string') return { code: 'SRF_NURBS_INVALID', message: `section ${i}: ${moved}`, section: i };
    out.push(moved);
  }
  return closed && mode === 'auto' ? closeSeams(out) : out;
}

/** A periodic loft's closing pair: the first seam moves to the point nearest to the last section's start, kept only when the worst twist of the pairs it touches drops. */
function closeSeams(sections: NurbsCurveData[]): NurbsCurveData[] | LoftIssue {
  const [first, last] = [sections[0] as NurbsCurveData, sections[sections.length - 1] as NurbsCurveData];
  if (sections.length < 3 || !isClosedCurve(first) || !isClosedCurve(last)) return sections;
  const rotate = rotationBetween(sectionNormal(last), sectionNormal(first));
  const offset = sub3(evaluateCurve(last, curveDomain(last)[0]), wireCentroid(last));
  const seam = nearestParameter(first, add3(wireCentroid(first), rotate(offset)));
  const moved = reseamCurve(first, seam);
  if (typeof moved === 'string') return { code: 'SRF_NURBS_INVALID', message: `section 0: ${moved}`, section: 0 };
  const twist = (head: NurbsCurveData): number => seamTwist([last, head, sections[1] as NurbsCurveData], false);
  return twist(moved) < twist(first) ? [moved, ...sections.slice(1)] : sections;
}

/** Largest angle in the plane of travel between the seam directions (start point seen from the centroid) of neighbouring closed sections; a closed loft includes the closing pair (last, first). */
export function seamTwist(sections: readonly NurbsCurveData[], closed: boolean): number {
  let worst = 0;
  for (let i = 0; i + (closed ? 0 : 1) < sections.length; i++) {
    const [p, q] = [sections[i] as NurbsCurveData, sections[(i + 1) % sections.length] as NurbsCurveData];
    if (!isClosedCurve(p) || !isClosedCurve(q)) continue;
    const axis = normalize3(sectionNormal(p));
    const flat = (curve: NurbsCurveData): Vec3 => {
      const d = sub3(sampleCurve(curve, 2)[0] as Vec3, wireCentroid(curve));
      return sub3(d, [axis[0] * dot3(d, axis), axis[1] * dot3(d, axis), axis[2] * dot3(d, axis)]);
    };
    const [a, b] = [flat(p), flat(q)];
    if (len3(a) < 1e-12 || len3(b) < 1e-12) continue;
    worst = Math.max(worst, Math.atan2(len3(cross3(a, b)), dot3(a, b)));
  }
  return worst;
}

/** Rotation-minimizing frames (double reflection) along the unit tangents of consecutive centreline points. */
function transportFrames(points: readonly Vec3[], tangents: readonly Vec3[], normal0: Vec3): Array<{ t: Vec3; n: Vec3; b: Vec3 }> {
  const reflect = (v: Vec3, axis: Vec3, c: number): Vec3 => sub3(v, scale3(axis, (2 / c) * dot3(axis, v)));
  const frames: Array<{ t: Vec3; n: Vec3; b: Vec3 }> = [];
  let n = normalize3(sub3(normal0, scale3(tangents[0] as Vec3, dot3(normal0, tangents[0] as Vec3))));
  frames.push({ t: tangents[0] as Vec3, n, b: cross3(tangents[0] as Vec3, n) });
  for (let i = 1; i < points.length; i++) {
    const v1 = sub3(points[i] as Vec3, points[i - 1] as Vec3);
    const c1 = dot3(v1, v1);
    const previous = frames[i - 1] as { t: Vec3; n: Vec3; b: Vec3 };
    let next = previous.n;
    if (c1 > 1e-24) {
      const reflected = reflect(previous.n, v1, c1);
      const v2 = sub3(tangents[i] as Vec3, reflect(previous.t, v1, c1));
      const c2 = dot3(v2, v2);
      next = c2 > 1e-24 ? reflect(reflected, v2, c2) : reflected;
    }
    n = normalize3(sub3(next, scale3(tangents[i] as Vec3, dot3(next, tangents[i] as Vec3))));
    frames.push({ t: tangents[i] as Vec3, n, b: cross3(tangents[i] as Vec3, n) });
  }
  return frames;
}

/**
 * Two compatible sections joined by `count` intermediate sections placed normal to `centerline` at equal arc length: each intermediate is the
 * blend (in the rotation-minimizing frame of the centreline) of the two end sections' coordinates.
 * @invariant the first and last sections are returned unchanged
 * @failure a centreline whose ends are not at the section centroids -> SWG_LOFT_CENTERLINE_MISSES
 */
export function centrelineSections(
  first: NurbsCurveData,
  last: NurbsCurveData,
  centerline: NurbsCurveData,
  count: number,
): NurbsCurveData[] | LoftIssue {
  const [a, b] = curveDomain(centerline);
  const [c0, c1] = [wireCentroid(first), wireCentroid(last)];
  const size = Math.max(distance3(c0, c1), 1e-9);
  const forward = distance3(evaluateCurve(centerline, a), c0) + distance3(evaluateCurve(centerline, b), c1);
  const backward = distance3(evaluateCurve(centerline, b), c0) + distance3(evaluateCurve(centerline, a), c1);
  const along = forward <= backward ? centerline : reverseCurve(centerline);
  const miss = Math.min(forward, backward);
  if (miss > 1e-4 * size)
    return {
      code: 'SWG_LOFT_CENTERLINE_MISSES',
      message: `the centreline ends are ${miss.toExponential(2)} from the section centres; start and end it at the sections`,
    };
  const stations = count + 2;
  const params = Array.from({ length: stations }, (_, k) =>
    k === 0 ? a : k === stations - 1 ? b : parameterAtLengthFraction(along, k / (stations - 1)),
  );
  const points = params.map((u) => evaluateCurve(along, u));
  const tangents = params.map((u) => normalize3(curveDerivatives(along, u, 1)[1] as Vec3));
  const reference = sub3(first.poles[0] as Vec3, c0);
  const frames = transportFrames(points, tangents, len3(reference) > 1e-12 ? reference : [1, 0, 0]);
  const local = (curve: NurbsCurveData, centre: Vec3, frame: { t: Vec3; n: Vec3; b: Vec3 }): Vec3[] =>
    curve.poles.map((pole): Vec3 => {
      const d = sub3(pole, centre);
      return [dot3(d, frame.n), dot3(d, frame.b), dot3(d, frame.t)];
    });
  const startLocal = local(first, c0, frames[0] as { t: Vec3; n: Vec3; b: Vec3 });
  const endLocal = local(last, c1, frames[stations - 1] as { t: Vec3; n: Vec3; b: Vec3 });
  const sections: NurbsCurveData[] = [first];
  for (let k = 1; k < stations - 1; k++) {
    const lambda = k / (stations - 1);
    const frame = frames[k] as { t: Vec3; n: Vec3; b: Vec3 };
    const poles = startLocal.map((p, i): Vec3 => {
      const q = endLocal[i] as Vec3;
      const x = (1 - lambda) * p[0] + lambda * q[0];
      const y = (1 - lambda) * p[1] + lambda * q[1];
      const z = (1 - lambda) * p[2] + lambda * q[2];
      return add3(points[k] as Vec3, add3(scale3(frame.n, x), add3(scale3(frame.b, y), scale3(frame.t, z))));
    });
    sections.push({ ...first, poles });
  }
  sections.push(last);
  return sections;
}
