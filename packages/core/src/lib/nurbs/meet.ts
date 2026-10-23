/** Closest points between two curves (the crossing of a curve network): a coarse pairing of samples, then damped Gauss-Newton on A(u) - B(v). */

import type { Vec3 } from '../../model/vectors';
import { distance3, dot3, sub3 } from '../vec3';
import { curveDerivatives, curveDomain } from './evaluate';
import type { NurbsCurveData } from './types';

const SAMPLES_PER_SPAN = 8;
const MIN_SAMPLES = 48;
const MAX_STEPS = 24;
/** Fraction of a curve's samples (either curve) a sample pair must lie away from the first crossing to count as another one. */
const SEPARATION = 0.2;
/** Fraction of a domain by which refined crossings must differ to be two crossings. */
const DISTINCT = 0.05;
const MAX_CANDIDATES = 4;

interface Sample {
  readonly t: number;
  readonly point: Vec3;
}

/** Parameter samples of a curve: at least MIN_SAMPLES, SAMPLES_PER_SPAN per knot span. */
function samplesOf(curve: NurbsCurveData): Sample[] {
  const [first, last] = curveDomain(curve);
  const count = Math.max(MIN_SAMPLES, (curve.knots.length - 1) * SAMPLES_PER_SPAN);
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = first + ((last - first) * i) / count;
    return { t, point: curveDerivatives(curve, t, 0)[0] as Vec3 };
  });
}

/** Damped Gauss-Newton on A(u) - B(v) from (u, v); parameters stay inside the domains. */
function refine(a: NurbsCurveData, b: NurbsCurveData, start: [number, number], startGap: number): [number, number, number] {
  const [da, db] = [curveDomain(a), curveDomain(b)];
  let [u, v] = start;
  let gap = startGap;
  for (let step = 0; step < MAX_STEPS && gap > 0; step++) {
    const [pa, ta] = curveDerivatives(a, u, 1) as [Vec3, Vec3];
    const [pb, tb] = curveDerivatives(b, v, 1) as [Vec3, Vec3];
    const f = sub3(pa, pb);
    // normal equations of min |f + ta du - tb dv|^2
    const [aa, ab, bb] = [dot3(ta, ta), -dot3(ta, tb), dot3(tb, tb)];
    const [ra, rb] = [-dot3(ta, f), dot3(tb, f)];
    const det = aa * bb - ab * ab;
    if (!(Math.abs(det) > 1e-18 * Math.max(aa * bb, 1e-300))) break;
    const du = (ra * bb - ab * rb) / det;
    const dv = (aa * rb - ab * ra) / det;
    const nextU = Math.min(da[1], Math.max(da[0], u + du));
    const nextV = Math.min(db[1], Math.max(db[0], v + dv));
    const next = distance3(curveDerivatives(a, nextU, 0)[0] as Vec3, curveDerivatives(b, nextV, 0)[0] as Vec3);
    const moved = Math.abs(nextU - u) + Math.abs(nextV - v);
    if (next <= gap) [u, v, gap] = [nextU, nextV, next];
    else break;
    if (moved < 1e-14 * (da[1] - da[0] + db[1] - db[0])) break;
  }
  return [u, v, gap];
}

/** Whether the curves meet a second time (within `tolerance`) away from the crossing found at sample pair (bi, bj). */
function meetsAgain(
  a: NurbsCurveData,
  b: NurbsCurveData,
  samples: readonly [readonly Sample[], readonly Sample[]],
  first: [number, number],
  best: { i: number; j: number },
  tolerance: number,
): boolean {
  const [sa, sb] = samples;
  const [da, db] = [curveDomain(a), curveDomain(b)];
  const resolution = Math.max(
    ...sa.slice(1).map((s, i) => distance3(s.point, (sa[i] as Sample).point)),
    ...sb.slice(1).map((s, i) => distance3(s.point, (sb[i] as Sample).point)),
  );
  const threshold = Math.max(tolerance, 1.5 * resolution);
  const [far, farB] = [SEPARATION * (sa.length - 1), SEPARATION * (sb.length - 1)];
  const candidates: Array<{ i: number; j: number; d: number }> = [];
  sa.forEach((p, i) =>
    sb.forEach((q, j) => {
      if (Math.abs(i - best.i) <= far && Math.abs(j - best.j) <= farB) return;
      const d = distance3(p.point, q.point);
      if (d <= threshold) candidates.push({ i, j, d });
    }),
  );
  candidates.sort((x, y) => x.d - y.d);
  for (const { i, j, d } of candidates.slice(0, MAX_CANDIDATES)) {
    const [u, v, gap] = refine(a, b, [(sa[i] as Sample).t, (sb[j] as Sample).t], d);
    // a closed curve met at its seam is one crossing seen at both parameter ends: the crossings must also lie apart in space
    const apart =
      (Math.abs(u - first[0]) / (da[1] - da[0]) > DISTINCT || Math.abs(v - first[1]) / (db[1] - db[0]) > DISTINCT) &&
      distance3(curveDerivatives(a, u, 0)[0] as Vec3, curveDerivatives(a, first[0], 0)[0] as Vec3) > 2 * threshold;
    if (gap <= tolerance && apart) return true;
  }
  return false;
}

/**
 * The pair of nearest points of two curves: [parameter on a, parameter on b, gap, crossesAgain], parameters as fractions 0..1 of each domain.
 * @invariant the start is the closest pair among the samples of both curves; Gauss-Newton keeps parameters inside the domains; `crossesAgain` is true
 *   when another crossing within `tolerance` exists elsewhere on both curves (the pair is then ambiguous)
 */
export function meetCurves(a: NurbsCurveData, b: NurbsCurveData, tolerance: number): [number, number, number, boolean] {
  const [sa, sb] = [samplesOf(a), samplesOf(b)];
  let best = { i: 0, j: 0, d: Number.POSITIVE_INFINITY };
  sa.forEach((p, i) =>
    sb.forEach((q, j) => {
      const d = distance3(p.point, q.point);
      if (d < best.d) best = { i, j, d };
    }),
  );
  const [da, db] = [curveDomain(a), curveDomain(b)];
  const [u, v, gap] = refine(a, b, [(sa[best.i] as Sample).t, (sb[best.j] as Sample).t], best.d);
  const point = (curve: NurbsCurveData): boolean => curve.poles.every((pole) => distance3(pole, curve.poles[0] as Vec3) < 1e-9);
  const again = gap <= tolerance && !point(a) && !point(b) && meetsAgain(a, b, [sa, sb], [u, v], best, tolerance);
  return [(u - da[0]) / (da[1] - da[0]), (v - db[0]) / (db[1] - db[0]), gap, again];
}
