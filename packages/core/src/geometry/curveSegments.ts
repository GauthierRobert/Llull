/**
 * @layer core/geometry
 * Pure math over exact curve chains (`CurveSegment`): evaluation, tangents, sampling, centripetal
 * Catmull-Rom → cubic Bézier conversion and polyline corner filleting. 2D points are lifted to
 * z = 0 internally, so every helper works for both `Vec2` profiles and `Vec3` paths.
 */

import type { CurveSegment } from '../model/curve';
import type { Vec2, Vec3 } from '../model/types';
import { add3, cross3, distance3, dot3, len3, lerp3, normalize3, scale3, sub3 } from '../lib/vec3';
import { angleFromCosine, positiveSweep } from '../lib/angle';

type Point = Vec2 | Vec3;

/** Path samples per full turn of an arc. */
const ARC_STEPS_PER_TURN = 32;
/** Samples per cubic Bézier. */
const BEZIER_STEPS = 16;
/** Joints whose tangents differ by more than this (radians) are corners. */
const G1_TOLERANCE = 1e-3;
/** Distance under which two chain points are considered the same. */
export const JOINT_TOLERANCE = 1e-6;

const lift = (p: Point): Vec3 => [p[0], p[1], p[2] ?? 0];

/** Circle through an arc's three points: centre, radius, start axis `u`, in-plane `v`, sweep angle. */
export interface ArcGeometry {
  readonly center: Vec3;
  readonly radius: number;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
  readonly sweep: number;
}

/** @failure collinear or coincident points -> null */
export function arcGeometry(start: Point, through: Point, end: Point): ArcGeometry | null {
  const [a, b, c] = [lift(start), lift(through), lift(end)];
  const e1 = sub3(b, a);
  const e2 = sub3(c, a);
  const n = cross3(e1, e2);
  const nn = dot3(n, n);
  if (nn < 1e-18 * Math.max(1, dot3(e1, e1) * dot3(e2, e2))) return null;
  const offset = scale3(
    add3(scale3(cross3(n, e1), dot3(e2, e2)), scale3(cross3(e2, n), dot3(e1, e1))),
    1 / (2 * nn),
  );
  const center = add3(a, offset);
  const radius = len3(offset);
  const normal = normalize3(n);
  const u = normalize3(sub3(a, center));
  const v = cross3(normal, u);
  const rel = sub3(c, center);
  const sweep = positiveSweep(Math.atan2(dot3(rel, v), dot3(rel, u)));
  return { center, radius, u, v, normal, sweep };
}

function arcPoint(g: ArcGeometry, t: number): Vec3 {
  const angle = g.sweep * t;
  return add3(
    g.center,
    add3(scale3(g.u, g.radius * Math.cos(angle)), scale3(g.v, g.radius * Math.sin(angle))),
  );
}

function bezierPoint(p: readonly Vec3[], t: number): Vec3 {
  const s = 1 - t;
  const weights = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
  const sum = (k: 0 | 1 | 2): number =>
    p.reduce((acc, point, i) => acc + (weights[i] ?? 0) * point[k], 0);
  return [sum(0), sum(1), sum(2)];
}

/** Point at parameter t in [0, 1] (3D; a 2D segment has z = 0). Degenerate arcs fall back to chords. */
export function segmentPoint(segment: CurveSegment<Point>, t: number): Vec3 {
  const pts = segment.points.map(lift);
  if (segment.type === 'bezier') return bezierPoint(pts, t);
  if (segment.type === 'arc') {
    const g = arcGeometry(segment.points[0], segment.points[1], segment.points[2]);
    if (g !== null) return arcPoint(g, t);
  }
  const [a, b] = [pts[0] as Vec3, pts[pts.length - 1] as Vec3];
  return lerp3(a, b, t);
}

/** Unit tangent at parameter t in [0, 1]; [0,0,0] when degenerate. */
export function segmentTangent(segment: CurveSegment<Point>, t: number): Vec3 {
  const pts = segment.points.map(lift);
  if (segment.type === 'arc') {
    const g = arcGeometry(segment.points[0], segment.points[1], segment.points[2]);
    if (g !== null) {
      const angle = g.sweep * t;
      return normalize3(add3(scale3(g.u, -Math.sin(angle)), scale3(g.v, Math.cos(angle))));
    }
  }
  if (segment.type === 'bezier') {
    const [p0, p1, p2, p3] = pts as [Vec3, Vec3, Vec3, Vec3];
    const s = 1 - t;
    const derivative = add3(
      add3(scale3(sub3(p1, p0), s * s), scale3(sub3(p2, p1), 2 * s * t)),
      scale3(sub3(p3, p2), t * t),
    );
    if (len3(derivative) > JOINT_TOLERANCE) return normalize3(derivative);
    const h = t < 0.5 ? 1e-3 : -1e-3;
    const step = sub3(segmentPoint(segment, t + h), segmentPoint(segment, t));
    return normalize3(h > 0 ? step : scale3(step, -1));
  }
  return normalize3(sub3(pts[pts.length - 1] as Vec3, pts[0] as Vec3));
}

/** Number of sample steps for one segment (a line needs one). */
export function segmentSteps(segment: CurveSegment<Point>): number {
  if (segment.type === 'line') return 1;
  if (segment.type === 'bezier') return BEZIER_STEPS;
  const g = arcGeometry(segment.points[0], segment.points[1], segment.points[2]);
  return g === null
    ? 1
    : Math.max(4, Math.ceil((g.sweep / (2 * Math.PI)) * ARC_STEPS_PER_TURN - 1e-9));
}

/** Samples of a chain, joints not repeated (an open chain keeps both ends; closed drops the last). */
export function sampleChain(segments: ReadonlyArray<CurveSegment<Point>>, closed: boolean): Vec3[] {
  const points: Vec3[] = [];
  segments.forEach((segment, index) => {
    const steps = segmentSteps(segment);
    for (let s = index === 0 ? 0 : 1; s <= steps; s++)
      points.push(segmentPoint(segment, s / steps));
  });
  if (closed && points.length > 1) points.pop();
  return points;
}

/** Closed 2D profile polygon of a closed chain (last point == first point is not repeated). */
export function sampleProfile(segments: ReadonlyArray<CurveSegment<Vec2>>): Vec2[] {
  return sampleChain(segments, true).map(([x, y]): Vec2 => [x, y]);
}

/** Same segment traversed backwards. */
function reverseSegment<P extends Point>(segment: CurveSegment<P>): CurveSegment<P> {
  const last = segment.points.length - 1;
  return mapSegment(segment, (_point, i) => segment.points[last - i] as P);
}

/** Chain traversed backwards. */
export function reverseChain<P extends Point>(
  segments: ReadonlyArray<CurveSegment<P>>,
): CurveSegment<P>[] {
  return [...segments].reverse().map(reverseSegment);
}

/** Every point mapped by `f` (scale, translate, plane change, snapping one end, …). */
export function mapSegment<P, Q>(
  segment: CurveSegment<P>,
  f: (point: P, index: number) => Q,
): CurveSegment<Q> {
  const [a, b] = segment.points;
  switch (segment.type) {
    case 'line':
      return { type: 'line', points: [f(a, 0), f(b, 1)] };
    case 'arc':
      return { type: 'arc', points: [f(a, 0), f(b, 1), f(segment.points[2], 2)] };
    case 'bezier': {
      const [, , c, d] = segment.points;
      return { type: 'bezier', points: [f(a, 0), f(b, 1), f(c, 2), f(d, 3)] };
    }
  }
}

const start = (segment: CurveSegment<Point>): Vec3 => lift(segment.points[0]);
const end = (segment: CurveSegment<Point>): Vec3 =>
  lift(segment.points[segment.points.length - 1] as Point);

/**
 * First problem of a chain, or null: empty, disconnected joints, degenerate arcs, and (closed) an
 * end that does not return to the start / (open) an end that does.
 */
export function chainIssue(
  segments: ReadonlyArray<CurveSegment<Point>>,
  closed: boolean,
): string | null {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) return 'the chain has no segments';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as CurveSegment<Point>;
    if (!segment.points.every((p) => p.every(Number.isFinite)))
      return `segment ${i} has a non-finite point`;
    if (distance3(start(segment), end(segment)) < JOINT_TOLERANCE)
      return `segment ${i} has zero length`;
    if (segment.type === 'arc' && arcGeometry(...segment.points) === null)
      return `arc ${i} has collinear points`;
    const next = segments[i + 1];
    if (next !== undefined && distance3(end(segment), start(next)) > JOINT_TOLERANCE)
      return `segment ${i + 1} does not start where segment ${i} ends`;
  }
  const loops = distance3(end(last), start(first)) <= JOINT_TOLERANCE;
  if (closed && !loops) return 'the chain does not end where it starts (not closed)';
  if (!closed && loops) return 'the path ends where it starts; closed paths are not supported';
  return null;
}

/** Index of the first joint (between segment i-1 and i) that is not tangent-continuous, or -1. */
export function firstCorner(segments: ReadonlyArray<CurveSegment<Point>>): number {
  for (let i = 1; i < segments.length; i++) {
    const a = segmentTangent(segments[i - 1] as CurveSegment<Point>, 1);
    const b = segmentTangent(segments[i] as CurveSegment<Point>, 0);
    if (angleFromCosine(dot3(a, b)) > G1_TOLERANCE) return i;
  }
  return -1;
}

/**
 * Centripetal Catmull-Rom through `points` as cubic Béziers — the same curve as three.js
 * `CatmullRomCurve3(points, closed, 'centripetal')` (open ends extrapolate by reflection).
 * @invariant points.length >= 2
 */
export function catmullRomBeziers<P extends Point>(
  points: ReadonlyArray<P>,
  closed: boolean,
): CurveSegment<P>[] {
  const lifted = points.map(lift);
  const n = lifted.length;
  const at = (i: number): Vec3 => {
    if (closed) return lifted[((i % n) + n) % n] as Vec3;
    if (i < 0) return sub3(scale3(lifted[0] as Vec3, 2), lifted[1] as Vec3);
    if (i >= n) return sub3(scale3(lifted[n - 1] as Vec3, 2), lifted[n - 2] as Vec3);
    return lifted[i] as Vec3;
  };
  const dims = (points[0] as P).length;
  const out = (v: Vec3): P => (dims === 2 ? [v[0], v[1]] : v) as unknown as P;
  const count = closed ? n : n - 1;
  const segments: CurveSegment<P>[] = [];
  for (let i = 0; i < count; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    let dt0 = Math.pow(distance3(p0, p1), 0.5);
    let dt1 = Math.pow(distance3(p1, p2), 0.5);
    let dt2 = Math.pow(distance3(p2, p3), 0.5);
    if (dt1 < 1e-4) dt1 = 1;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    const tangent = (a: Vec3, b: Vec3, c: Vec3, d0: number, d1: number): Vec3 =>
      scale3(
        add3(
          sub3(scale3(sub3(b, a), 1 / d0), scale3(sub3(c, a), 1 / (d0 + d1))),
          scale3(sub3(c, b), 1 / d1),
        ),
        dt1,
      );
    const m1 = tangent(p0, p1, p2, dt0, dt1);
    const m2 = tangent(p1, p2, p3, dt1, dt2);
    segments.push({
      type: 'bezier',
      points: [
        out(p1),
        out(add3(p1, scale3(m1, 1 / 3))),
        out(sub3(p2, scale3(m2, 1 / 3))),
        out(p2),
      ],
    });
  }
  return segments;
}

/**
 * Open 3D polyline with every interior corner rounded by a circular arc of `bendRadius`
 * (straight runs stay lines). Collinear corners need no arc.
 * @failure a U-turn, or bends that overlap on a run -> error string
 */
export function filletPolyline(
  points: ReadonlyArray<Vec3>,
  bendRadius: number,
): CurveSegment<Vec3>[] | string {
  type Bend = {
    readonly enter: Vec3;
    readonly mid: Vec3;
    readonly exit: Vec3;
    readonly cut: number;
  };
  const bends: Array<Bend | null> = [];
  for (let i = 1; i < points.length - 1; i++) {
    const [prev, corner, next] = [points[i - 1], points[i], points[i + 1]] as [Vec3, Vec3, Vec3];
    const dIn = normalize3(sub3(corner, prev));
    const dOut = normalize3(sub3(next, corner));
    const turn = angleFromCosine(dot3(dIn, dOut));
    if (turn < G1_TOLERANCE) {
      bends.push(null);
      continue;
    }
    if (Math.PI - turn < 1e-6) return `the path doubles back on itself at point ${i}`;
    const cut = bendRadius * Math.tan(turn / 2);
    const toCenter = normalize3(sub3(dOut, dIn));
    const center = add3(corner, scale3(toCenter, bendRadius / Math.cos(turn / 2)));
    bends.push({
      enter: sub3(corner, scale3(dIn, cut)),
      exit: add3(corner, scale3(dOut, cut)),
      mid: add3(center, scale3(normalize3(sub3(corner, center)), bendRadius)),
      cut,
    });
  }
  const segments: CurveSegment<Vec3>[] = [];
  let cursor = points[0] as Vec3;
  for (let i = 1; i < points.length; i++) {
    const run = distance3(points[i - 1] as Vec3, points[i] as Vec3);
    const cutBefore = bends[i - 2]?.cut ?? 0;
    const bend = bends[i - 1] ?? null;
    if (run < JOINT_TOLERANCE) return `points ${i - 1} and ${i} coincide`;
    if (cutBefore + (bend?.cut ?? 0) > run + JOINT_TOLERANCE)
      return `bendRadius ${bendRadius} is too large for the run between points ${i - 1} and ${i} (length ${run.toFixed(3)})`;
    const lineEnd = bend === null ? (points[i] as Vec3) : bend.enter;
    if (distance3(cursor, lineEnd) > JOINT_TOLERANCE)
      segments.push({ type: 'line', points: [cursor, lineEnd] });
    if (bend !== null) {
      segments.push({ type: 'arc', points: [bend.enter, bend.mid, bend.exit] });
      cursor = bend.exit;
    } else {
      cursor = lineEnd;
    }
  }
  return segments;
}

/**
 * Closed 3D polygon with every corner rounded by `bendRadius`: the open polyline from the middle
 * of the closing edge round all vertices and back, so the chain closes on a straight (G1) joint.
 * Each closing-edge half must fit its own bend.
 */
export function filletClosedPolygon(
  points: ReadonlyArray<Vec3>,
  bendRadius: number,
): CurveSegment<Vec3>[] | string {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length < 3 || first === undefined || last === undefined)
    return 'a closed path needs at least 3 points';
  const mid = scale3(add3(first, last), 0.5);
  return filletPolyline([mid, ...points, mid], bendRadius);
}

/** Whether a chain ends where it starts (within JOINT_TOLERANCE). */
export function isClosedChain(segments: ReadonlyArray<CurveSegment<Point>>): boolean {
  const first = segments[0];
  const last = segments[segments.length - 1];
  return (
    first !== undefined &&
    last !== undefined &&
    distance3(start(first), end(last)) <= JOINT_TOLERANCE
  );
}

/** Whether the closing joint of a closed chain is tangent-continuous. */
export function closesSmoothly(segments: ReadonlyArray<CurveSegment<Point>>): boolean {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) return false;
  const a = segmentTangent(last, 1);
  const b = segmentTangent(first, 0);
  return angleFromCosine(dot3(a, b)) <= G1_TOLERANCE;
}

/** Arc length of a chain: exact for lines and arcs, 64-chord estimate for Béziers. */
export function chainLength(segments: ReadonlyArray<CurveSegment<Point>>): number {
  return segments.reduce((total, segment) => {
    if (segment.type === 'arc') {
      const g = arcGeometry(...segment.points);
      if (g !== null) return total + g.radius * g.sweep;
    }
    const steps = segment.type === 'bezier' ? 64 : 1;
    let length = 0;
    for (let s = 1; s <= steps; s++)
      length += distance3(segmentPoint(segment, (s - 1) / steps), segmentPoint(segment, s / steps));
    return total + length;
  }, 0);
}

/** Smallest radius of curvature along a segment (Infinity for lines; sampled for Béziers). */
export function minCurvatureRadius(segment: CurveSegment<Point>): number {
  if (segment.type === 'line') return Infinity;
  if (segment.type === 'arc') return arcGeometry(...segment.points)?.radius ?? Infinity;
  const [p0, p1, p2, p3] = segment.points.map(lift) as [Vec3, Vec3, Vec3, Vec3];
  let least = Infinity;
  for (let s = 0; s <= 64; s++) {
    const t = s / 64;
    const u = 1 - t;
    const d1 = add3(
      add3(scale3(sub3(p1, p0), 3 * u * u), scale3(sub3(p2, p1), 6 * u * t)),
      scale3(sub3(p3, p2), 3 * t * t),
    );
    const d2 = add3(
      scale3(add3(sub3(p2, scale3(p1, 2)), p0), 6 * u),
      scale3(add3(sub3(p3, scale3(p2, 2)), p1), 6 * t),
    );
    const bend = len3(cross3(d1, d2));
    if (bend > 1e-12) least = Math.min(least, len3(d1) ** 3 / bend);
  }
  return least;
}
