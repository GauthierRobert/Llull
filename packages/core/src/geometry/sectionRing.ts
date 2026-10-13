/**
 * @layer core/geometry
 * Section rings: any closed section resampled to SECTION_RING_POINTS points (counter-clockwise,
 * arc-length spaced, starting at the +x side) and read as a closed centripetal Catmull-Rom curve.
 * Every ring has the same point count, so rings can be interpolated (variable-section sweeps) or
 * skinned (lofts), and the exact kernel gets wires with the same number of Bézier edges.
 */

import type { CurveSegment } from '../model/curve';
import type { Vec2, Vec3 } from '../model/types';
import { toCounterClockwise } from '../lib/polygon';
import { catmullRomBeziers, segmentPoint } from './curveSegments';
import { segmentLengths } from '../lib/polyline';
import { centroid2 } from '../lib/vec2';

/** Points per section ring. */
export const SECTION_RING_POINTS = 24;

/**
 * `count` points evenly spaced by arc length around a closed polygon, counter-clockwise, starting
 * where the boundary crosses the +x ray from the centroid of its vertices.
 * @invariant polygon has >= 3 points and non-zero area
 */
export function resampleRing(polygon: ReadonlyArray<Vec2>, count = SECTION_RING_POINTS): Vec2[] {
  const ccw = toCounterClockwise(polygon);
  const [cx, cy] = centroid2(ccw);
  let startEdge = 0;
  let startT = 0;
  let bestX = -Infinity;
  ccw.forEach((a, i) => {
    const b = ccw[(i + 1) % ccw.length] as Vec2;
    if ((a[1] - cy) * (b[1] - cy) > 0 || a[1] === b[1]) return;
    const t = (cy - a[1]) / (b[1] - a[1]);
    const x = a[0] + t * (b[0] - a[0]);
    if (x > cx && x > bestX) {
      bestX = x;
      startEdge = i;
      startT = t;
    }
  });
  const start: Vec2 = [
    (ccw[startEdge] as Vec2)[0] + startT * ((ccw[(startEdge + 1) % ccw.length] as Vec2)[0] - (ccw[startEdge] as Vec2)[0]),
    (ccw[startEdge] as Vec2)[1] + startT * ((ccw[(startEdge + 1) % ccw.length] as Vec2)[1] - (ccw[startEdge] as Vec2)[1]),
  ];
  const loop: Vec2[] = [start];
  for (let k = 1; k <= ccw.length; k++) loop.push(ccw[(startEdge + k) % ccw.length] as Vec2);
  loop.push(start);
  const lengths = segmentLengths(loop);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const ring: Vec2[] = [];
  let edge = 0;
  let walked = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (edge < lengths.length - 1 && walked + (lengths[edge] as number) < target) {
      walked += lengths[edge] as number;
      edge++;
    }
    const a = loop[edge] as Vec2;
    const b = loop[edge + 1] as Vec2;
    const t = (lengths[edge] as number) > 0 ? (target - walked) / (lengths[edge] as number) : 0;
    ring.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  }
  return ring;
}

/** `ring` cyclically shifted to best match `reference` point-for-point (least squared distance). */
export function alignRing<P extends Vec2 | Vec3>(ring: ReadonlyArray<P>, reference: ReadonlyArray<P>): P[] {
  let bestShift = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < ring.length; shift++) {
    let cost = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[(i + shift) % ring.length] as P;
      const q = reference[i] as P;
      for (let k = 0; k < p.length; k++) cost += ((p[k] ?? 0) - (q[k] ?? 0)) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }
  return ring.map((_, i) => ring[(i + bestShift) % ring.length] as P);
}

/** The ring's closed curve: one cubic Bézier per ring point. */
export function ringCurves<P extends Vec2 | Vec3>(ring: ReadonlyArray<P>): CurveSegment<P>[] {
  return catmullRomBeziers(ring, true);
}

/** Samples per ring point when tessellating a ring curve. */
const RING_STEPS = 4;

/** Dense sample of the ring's closed curve (RING_STEPS per ring point, same count for every ring). */
export function sampleRing(ring: ReadonlyArray<Vec2 | Vec3>): Vec3[] {
  return ringCurves(ring).flatMap((segment) => Array.from({ length: RING_STEPS }, (_, s) => segmentPoint(segment, s / RING_STEPS)));
}
