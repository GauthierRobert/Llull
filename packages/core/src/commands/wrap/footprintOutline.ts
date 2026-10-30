/**
 * The footprint of a relief along a pull (03 WRP M5): the image of a closed loop of (u, v) pieces on the face, projected along the pull onto the plane (e1, e2), as the outline of the
 * prism the relief is cut with.
 * - `fittedOutline`: lines and cubic Beziers (Hermite ends from the exact tangent) split until the quarter points are within `tolerance` of the image: few faces, fast booleans.
 * - `sampledPolygon`: a polygon whose chord sag against the image is within `tolerance` (up to MAX_SAMPLES per piece): planar walls, which a draft needs.
 * @invariant both report the largest deviation from the exact image they were accepted at, in document units; an outline is counter-clockwise
 */

import type { Vec2, Vec3 } from '../../model/types';
import type { CurveSegment } from '../../model/curve';
import { sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import { pointAt2 } from '../../lib/nurbs/curve2d';
import { cross3, dot3, sub3 } from '../../lib/vec3';

export interface Outline {
  /** Lines and Beziers of the outline, joined end to start (absent for a sampled polygon). */
  readonly segments: CurveSegment<Vec2>[] | undefined;
  /** The polygon, or the tessellation of the segments. */
  readonly profile: Vec2[];
  readonly deviation: number;
}

const MAX_SPLIT_DEPTH = 9;
const MAX_SAMPLES = 256;
const FIRST_SAMPLES = 8;
const CHECKS = [0.25, 0.5, 0.75];

/** The (u, v) point at fraction `s` of a piece. */
function uvOnPiece(piece: PlaneSegment, s: number): Vec2 {
  if (piece.kind === 'line') return [piece.from[0] + s * (piece.to[0] - piece.from[0]), piece.from[1] + s * (piece.to[1] - piece.from[1])];
  const from = piece.curve.knots[0] as number;
  const to = piece.curve.knots[piece.curve.knots.length - 1] as number;
  return pointAt2(piece.curve, from + s * (to - from));
}

const bezierAt = (p: readonly [Vec2, Vec2, Vec2, Vec2], s: number): Vec2 => {
  const [a, b, c, d] = [(1 - s) ** 3, 3 * s * (1 - s) ** 2, 3 * s * s * (1 - s), s ** 3];
  return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]];
};

const signedArea = (polygon: readonly Vec2[]): number =>
  polygon.reduce((sum, p, k) => {
    const next = polygon[(k + 1) % polygon.length] as Vec2;
    return sum + p[0] * next[1] - next[0] * p[1];
  }, 0);

function fitPiece(
  image: (uv: Vec2) => Vec3,
  piece: PlaneSegment,
  e1: Vec3,
  e2: Vec3,
  tolerance: number,
): { segments: CurveSegment<Vec2>[]; deviation: number } {
  const projected = (s: number): Vec2 => {
    const p = image(uvOnPiece(piece, s));
    return [dot3(p, e1), dot3(p, e2)];
  };
  const step = 1e-6;
  const slope = (s: number): Vec2 => {
    const [lo, hi] = [Math.max(0, s - step), Math.min(1, s + step)];
    const [a, b] = [projected(lo), projected(hi)];
    return [(b[0] - a[0]) / (hi - lo), (b[1] - a[1]) / (hi - lo)];
  };
  const segments: CurveSegment<Vec2>[] = [];
  let deviation = 0;
  const fit = (s0: number, s1: number, depth: number): void => {
    const [p0, p1] = [projected(s0), projected(s1)];
    const h = s1 - s0;
    const [t0, t1] = [slope(s0), slope(s1)];
    const control: readonly [Vec2, Vec2, Vec2, Vec2] = [
      p0,
      [p0[0] + (t0[0] * h) / 3, p0[1] + (t0[1] * h) / 3],
      [p1[0] - (t1[0] * h) / 3, p1[1] - (t1[1] * h) / 3],
      p1,
    ];
    let line = 0;
    let curve = 0;
    for (const q of CHECKS) {
      const truth = projected(s0 + q * h);
      const onCurve = bezierAt(control, q);
      curve = Math.max(curve, Math.hypot(truth[0] - onCurve[0], truth[1] - onCurve[1]));
      const chord: Vec2 = [p0[0] + q * (p1[0] - p0[0]), p0[1] + q * (p1[1] - p0[1])];
      line = Math.max(line, Math.hypot(truth[0] - chord[0], truth[1] - chord[1]));
    }
    if (line <= tolerance) {
      deviation = Math.max(deviation, line);
      segments.push({ type: 'line', points: [p0, p1] });
    } else if (curve <= tolerance || depth >= MAX_SPLIT_DEPTH) {
      deviation = Math.max(deviation, curve);
      segments.push({ type: 'bezier', points: control });
    } else {
      fit(s0, s0 + h / 2, depth + 1);
      fit(s0 + h / 2, s1, depth + 1);
    }
  };
  fit(0, 1, 0);
  return { segments, deviation };
}

const tessellated = (segments: readonly CurveSegment<Vec2>[]): Vec2[] =>
  segments.flatMap((segment) =>
    segment.type === 'bezier'
      ? [0, 0.25, 0.5, 0.75].map((s) => bezierAt(segment.points as [Vec2, Vec2, Vec2, Vec2], s))
      : [segment.points[0]],
  );

const reversedSegment = (segment: CurveSegment<Vec2>): CurveSegment<Vec2> =>
  segment.type === 'bezier'
    ? { type: 'bezier', points: [segment.points[3], segment.points[2], segment.points[1], segment.points[0]] }
    : { type: 'line', points: [segment.points[1] as Vec2, segment.points[0] as Vec2] };

/** The Bezier / line outline of a closed loop (see the module comment). */
export function fittedOutline(image: (uv: Vec2) => Vec3, pieces: readonly PlaneSegment[], e1: Vec3, e2: Vec3, tolerance: number): Outline {
  const fitted = pieces.map((piece) => fitPiece(image, piece, e1, e2, tolerance));
  const forward = fitted.flatMap((entry) => entry.segments);
  const counterClockwise = signedArea(tessellated(forward)) >= 0;
  const segments = counterClockwise ? forward : [...forward].reverse().map(reversedSegment);
  return { segments, profile: tessellated(segments), deviation: Math.max(0, ...fitted.map((entry) => entry.deviation)) };
}

const chordSag = (a: Vec3, mid: Vec3, b: Vec3): number => {
  const chord = sub3(b, a);
  const length = Math.hypot(...chord);
  const toMid = sub3(mid, a);
  return length > 0 ? Math.hypot(...cross3(chord, toMid)) / length : Math.hypot(...toMid);
};

/** The polygon outline of a closed loop, repeated and collinear points removed (see the module comment). */
export function sampledPolygon(
  image: (uv: Vec2) => Vec3,
  pieces: readonly PlaneSegment[],
  e1: Vec3,
  e2: Vec3,
  tolerance: number,
  scale: number,
): Outline {
  const points: Vec3[] = [];
  let deviation = 0;
  for (const piece of pieces) {
    let count = FIRST_SAMPLES;
    let found = 0;
    for (;;) {
      const images = sampleSegment(piece, 2 * count + 1).map(image);
      found = 0;
      for (let k = 0; k < count; k++)
        found = Math.max(found, chordSag(images[2 * k] as Vec3, images[2 * k + 1] as Vec3, images[2 * k + 2] as Vec3));
      if (found <= tolerance || count >= MAX_SAMPLES) break;
      count *= 2;
    }
    deviation = Math.max(deviation, found);
    points.push(
      ...sampleSegment(piece, count + 1)
        .slice(0, -1)
        .map(image),
    );
  }
  const flat = points.map((p): Vec2 => [dot3(p, e1), dot3(p, e2)]);
  const eps = 1e-9 * scale;
  const kept: Vec2[] = [];
  for (const point of flat) {
    const previous = kept[kept.length - 1] ?? (flat[flat.length - 1] as Vec2);
    if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= eps) kept.push(point);
  }
  const simplified = kept.filter((point, k) => {
    const previous = kept[(k + kept.length - 1) % kept.length] as Vec2;
    const next = kept[(k + 1) % kept.length] as Vec2;
    const cross = (point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0]);
    return Math.abs(cross) > eps * Math.hypot(next[0] - previous[0], next[1] - previous[1]);
  });
  return { segments: undefined, profile: signedArea(simplified) < 0 ? [...simplified].reverse() : simplified, deviation };
}

/**
 * Thinnest place of a region made of `loops` (outer boundary and holes, polygons): the smallest distance from a point of a boundary (the vertices and points between them, about
 * 500 per loop) to a boundary edge that is not local to it: whose position along its loop is farther than 1.5 times that distance (so the neighbours of a finely sampled curve and the
 * two sides of a corner of 67 degrees or more do not count; a slot end or a disc does). A point within four distances (along the loop) of a sharper tip is not counted either: a tip is eaten
 * by a draft, a stroke is closed by it. Another loop is always non-local.
 */
export function thinnestPlace(loops: readonly (readonly Vec2[])[]): number {
  interface Probe {
    readonly point: Vec2;
    readonly loop: number;
    readonly arc: number;
  }
  const info = loops.map((loop) => {
    const lengths = loop.map((p, k) =>
      Math.hypot((loop[(k + 1) % loop.length] as Vec2)[0] - p[0], (loop[(k + 1) % loop.length] as Vec2)[1] - p[1]),
    );
    const starts: number[] = [];
    let total = 0;
    for (const length of lengths) {
      starts.push(total);
      total += length;
    }
    return { lengths, starts, total };
  });
  // arcs of the vertices whose edges meet at less than 67 degrees (tips)
  const tips = loops.map((loop, l) =>
    loop.flatMap((vertex, k) => {
      const [before, after] = [loop[(k + loop.length - 1) % loop.length] as Vec2, loop[(k + 1) % loop.length] as Vec2];
      const [a, b] = [Math.hypot(before[0] - vertex[0], before[1] - vertex[1]), Math.hypot(after[0] - vertex[0], after[1] - vertex[1])];
      const cosine =
        a > 0 && b > 0
          ? ((before[0] - vertex[0]) * (after[0] - vertex[0]) + (before[1] - vertex[1]) * (after[1] - vertex[1])) / (a * b)
          : -1;
      return cosine > Math.cos((67 * Math.PI) / 180) ? [(info[l] as (typeof info)[number]).starts[k] as number] : [];
    }),
  );
  const probes: Probe[] = [];
  for (const [l, loop] of loops.entries()) {
    const { lengths, starts, total } = info[l] as (typeof info)[number];
    const step = total / 500;
    for (const [k, from] of loop.entries()) {
      const to = loop[(k + 1) % loop.length] as Vec2;
      const pieces = Math.max(1, Math.ceil((lengths[k] as number) / step));
      for (let piece = 0; piece < pieces; piece++) {
        const t = piece / pieces;
        probes.push({
          point: [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])],
          loop: l,
          arc: (starts[k] as number) + t * (lengths[k] as number),
        });
      }
    }
  }
  let best = Infinity;
  for (const probe of probes)
    for (const [l, loop] of loops.entries())
      for (let j = 0; j < loop.length; j++) {
        const from = loop[j] as Vec2;
        const to = loop[(j + 1) % loop.length] as Vec2;
        const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
        const length2 = dx * dx + dy * dy;
        const t = length2 > 0 ? Math.max(0, Math.min(1, ((probe.point[0] - from[0]) * dx + (probe.point[1] - from[1]) * dy) / length2)) : 0;
        const distance = Math.hypot(probe.point[0] - (from[0] + t * dx), probe.point[1] - (from[1] + t * dy));
        if (!(distance < best)) continue;
        if (l === probe.loop) {
          const own = info[l] as (typeof info)[number];
          const arc = Math.abs(probe.arc - ((own.starts[j] as number) + t * (own.lengths[j] as number)));
          if (Math.min(arc, own.total - arc) <= 1.5 * distance + 1e-9 * own.total) continue;
          const nearTip = (tips[l] as number[]).some((at) => {
            const apart = Math.abs(probe.arc - at);
            return Math.min(apart, own.total - apart) <= 4 * distance;
          });
          if (nearTip) continue;
        }
        best = distance;
      }
  return best;
}
