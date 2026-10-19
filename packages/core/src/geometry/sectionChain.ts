/**
 * Exact loft sections (loft v3): an open NURBS section as the closed wire the exact kernel skins, and as the dense ring the mesh fallback
 * draws. A cubic non-rational section is exactly a chain of cubic Béziers (Bézier extraction by knot insertion), so the native kernel
 * receives the very curve the document holds - no resampling.
 */

import type { CurveSegment } from '../model/curve';
import type { Vec3 } from '../model/types';
import { distance3 } from '../lib/vec3';
import { elevateDegree, insertKnot } from '../lib/nurbs/edit';
import type { NurbsCurveData } from '../lib/nurbs/types';
import { evaluateCurve } from '../lib/nurbs/evaluate';

/** Cubic Bézier spans of `curve`: degree 1..3 non-rational, else null (degree above 3 or rational). */
function bezierPoles(curve: NurbsCurveData): ReadonlyArray<Vec3> | null {
  if (curve.weights !== undefined || curve.degree > 3) return null;
  let current: NurbsCurveData | string = curve.degree === 3 ? curve : elevateDegree(curve, 3 - curve.degree);
  for (let index = 1; typeof current !== 'string' && index < current.knots.length - 1; index++) {
    const have = current.multiplicities[index] as number;
    if (have < 3) current = insertKnot(current, current.knots[index] as number, 3 - have);
  }
  return typeof current === 'string' ? null : current.poles;
}

/** True when the section's end point differs from its start, so a straight closing edge belongs to the wire. */
export function hasClosingEdge(curve: NurbsCurveData): boolean {
  const start = curve.poles[0] as Vec3;
  const end = curve.poles[curve.poles.length - 1] as Vec3;
  return distance3(start, end) > 1e-9 * Math.max(1, ...curve.poles.map((pole) => distance3(pole, start)));
}

/**
 * The section as a closed wire: its cubic Bézier spans, then a line from its end back to its start when they differ. Null for a section
 * the exact kernel cannot take as Béziers (rational or degree above 3): the caller falls back to `rings`.
 */
export function sectionChain(curve: NurbsCurveData): CurveSegment<Vec3>[] | null {
  const poles = bezierPoles(curve);
  if (poles === null) return null;
  const chain: CurveSegment<Vec3>[] = [];
  for (let start = 0; start + 3 < poles.length; start += 3)
    chain.push({
      type: 'bezier',
      points: [poles[start], poles[start + 1], poles[start + 2], poles[start + 3]] as [Vec3, Vec3, Vec3, Vec3],
    });
  if (hasClosingEdge(curve)) chain.push({ type: 'line', points: [poles[poles.length - 1] as Vec3, poles[0] as Vec3] });
  return chain;
}

/** Ring points wanted per section by the mesh fallback: a coarse curve is sampled finer, a long one once per knot span. */
const RING_POINTS = 48;

/**
 * Closed ring of the section for the mesh fallback (no repeated end point): the same number of points per knot span (at least
 * RING_POINTS in all), so sections with equal span counts get equal point counts.
 */
export function sectionRing(curve: NurbsCurveData): Vec3[] {
  const perSpan = Math.max(1, Math.ceil(RING_POINTS / (curve.knots.length - 1)));
  const points: Vec3[] = [];
  for (let span = 0; span + 1 < curve.knots.length; span++) {
    const [from, to] = [curve.knots[span] as number, curve.knots[span + 1] as number];
    for (let step = 0; step < perSpan; step++) points.push(evaluateCurve(curve, from + ((to - from) * step) / perSpan));
  }
  const end = evaluateCurve(curve, curve.knots[curve.knots.length - 1] as number);
  return hasClosingEdge(curve) ? [...points, end] : points;
}
