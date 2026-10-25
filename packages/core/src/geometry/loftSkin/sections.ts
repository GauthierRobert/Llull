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

/** Rotation by `angle` about the unit `axis` (Rodrigues). */
function rotateAbout(axis: Vec3, angle: number): (v: Vec3) => Vec3 {
  const [sine, cosine] = [Math.sin(angle), Math.cos(angle)];
  return (v) => add3(add3(scale3(v, cosine), scale3(cross3(axis, v), sine)), scale3(axis, dot3(axis, v) * (1 - cosine)));
}

/** Fraction of the travel below which a section normal counts as perpendicular to it. */
const EDGE_ON = 1e-6;

/**
 * Unit normals of the section planes, each signed to point along the direction of travel (centroid of the next section minus centroid of the previous one;
 * cyclic when `closed`). A section wound against the others thus does not turn the loop the wrong way, however far the planes turn between neighbours
 * (a sign taken from the previous normal alone breaks when a step turns by 90 degrees or more). A section edge-on to the travel, or a travel of zero, is signed
 * like the previous section's axis.
 */
function travelAxes(curves: readonly NurbsCurveData[], closed: boolean): Vec3[] {
  const centroids = curves.map(wireCentroid);
  const count = curves.length;
  const axes: Vec3[] = [];
  curves.forEach((curve, i) => {
    const before = centroids[closed ? (i + count - 1) % count : Math.max(i - 1, 0)] as Vec3;
    const after = centroids[closed ? (i + 1) % count : Math.min(i + 1, count - 1)] as Vec3;
    const axis = normalize3(sectionNormal(curve));
    const travel = sub3(after, before);
    const along = dot3(axis, travel);
    // an edge-on section (the plane contains the travel) or no travel at all (a 2-section closed loft) has no sign of its own: follow the previous axis
    const undecided = len3(travel) < 1e-12 || Math.abs(along) < EDGE_ON * len3(travel);
    const previous = axes[i - 1];
    const forward = undecided ? (previous === undefined ? true : dot3(axis, previous) >= 0) : along > 0;
    axes.push(forward ? axis : scale3(axis, -1));
  });
  return axes;
}

/** Where the start of `previous` (plane axis `from`) lands on a plane of axis `to`: its offset from the centroid, carried by the minimal rotation between the axes. */
function carriedStart(previous: NurbsCurveData, from: Vec3, to: Vec3): Vec3 {
  return rotationBetween(from, to)(sub3(evaluateCurve(previous, curveDomain(previous)[0]), wireCentroid(previous)));
}

/**
 * Seams of closed sections moved by exact re-seaming. `auto`: each section starts at the point nearest to the previous section's start
 * (carried over by the translation and the minimal rotation between their planes, then turned about the section axis by `drift`); `seams`:
 * at the given parameter fractions.
 * @failure a failing knot insertion -> LoftIssue
 */
function alignPass(
  curves: readonly NurbsCurveData[],
  mode: 'auto' | 'seams',
  seams: readonly number[] | undefined,
  drift: number,
  closed: boolean,
): NurbsCurveData[] | LoftIssue {
  const out: NurbsCurveData[] = [];
  const axes = travelAxes(curves, closed);
  for (const [i, curve] of curves.entries()) {
    const axis = axes[i] as Vec3;
    let seam: number | null = null;
    if (!isClosedCurve(curve)) seam = null;
    else if (mode === 'seams') {
      const [a, b] = curveDomain(curve);
      const fraction = seams?.[i] ?? 0;
      seam = a + (b - a) * fraction;
    } else if (i > 0) {
      const carried = rotateAbout(axis, drift)(carriedStart(out[i - 1] as NurbsCurveData, axes[i - 1] as Vec3, axis));
      seam = nearestParameter(curve, add3(wireCentroid(curve), carried));
    }
    if (seam === null) {
      out.push(curve);
      continue;
    }
    const moved = reseamCurve(curve, seam);
    if (typeof moved === 'string') return { code: 'SRF_NURBS_INVALID', message: `section ${i}: ${moved}`, section: i };
    out.push(moved);
  }
  return out;
}

/**
 * Seam alignment of the sections of a loft.
 * @invariant a closed loft carries the sections' start around the loop by the minimal rotation between neighbouring planes, which gains a holonomy
 *   (the start carried round the whole loop does not meet the first one); that closure drift is shared out evenly over all pairs, the closing pair
 *   included, so no single pair twists by all of it. The shared-out result is kept only when its worst pair twist is lower.
 */
export function alignSections(
  curves: readonly NurbsCurveData[],
  mode: 'auto' | 'none' | 'seams',
  seams: readonly number[] | undefined,
  closed = false,
): NurbsCurveData[] | LoftIssue {
  if (mode === 'none') return [...curves];
  const sequential = alignPass(curves, mode, seams, 0, closed);
  if (!closed || mode !== 'auto' || !Array.isArray(sequential)) return sequential;
  const drift = closureDrift(sequential);
  if (Math.abs(drift) < 1e-9) return sequential;
  const shared = alignPass(curves, 'auto', undefined, drift / curves.length, true);
  return Array.isArray(shared) && seamTwist(shared, true) < seamTwist(sequential, true) ? shared : sequential;
}

/**
 * Signed angle about the first section's axis from the last section's start (carried onto the first plane) to the first section's own start; 0 for open or
 * short loops.
 * @invariant the axes point along the travel (`travelAxes`), so the sign of the angle is the sense of the loop whatever the winding of each section
 */
function closureDrift(sections: readonly NurbsCurveData[]): number {
  const [first, last] = [sections[0] as NurbsCurveData, sections[sections.length - 1] as NurbsCurveData];
  if (sections.length < 3 || !isClosedCurve(first) || !isClosedCurve(last)) return 0;
  const axes = travelAxes(sections, true);
  const axis = axes[0] as Vec3;
  const flatten = (v: Vec3): Vec3 => sub3(v, scale3(axis, dot3(v, axis)));
  const carried = flatten(carriedStart(last, axes[sections.length - 1] as Vec3, axis));
  const own = flatten(sub3(evaluateCurve(first, curveDomain(first)[0]), wireCentroid(first)));
  if (len3(carried) < 1e-12 || len3(own) < 1e-12) return 0;
  return Math.atan2(dot3(cross3(carried, own), axis), dot3(carried, own));
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
