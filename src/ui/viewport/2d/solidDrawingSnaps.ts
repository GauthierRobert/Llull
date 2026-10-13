/**
 * Snap points of a solid's drawing — read off the drawn edges, so a snap is always on a line the
 * user sees:
 *  - endpoint: chain ends and real corners (turn above CORNER_ANGLE; a tessellated curve is smooth
 *    and gives none per chord) plus the quadrant points of smooth curves;
 *  - midpoint: the middle of each straight run (collinear segments merged);
 *  - center: the crossing of each centre mark (two perpendicular centre lines sharing a midpoint).
 */

import type { SegmentChain } from '@core/geometry/planeEdges';
import { type DrawingPrimitive, drawingTolerance } from '@core/model/drawing';
import type { Vec2 } from '@core/model/types';
import { quantizedKey } from '@lib/quantize';
import type { SnapPoint } from './snapping/types';
import { drawingChains } from './solidDrawingEdges';

/** A vertex turning at least this is always a corner (radians, 45 degrees). */
const CORNER_ANGLE = Math.PI / 4;
/** Turns of a regular arc agree within this relative / absolute (radians, 2 degrees) margin. */
const TURN_MATCH = 0.2;
const TURN_MATCH_MIN = (2 * Math.PI) / 180;
/** Adjacent chords of a regular arc differ in length by less than this ratio. */
const CHORD_RATIO = 1.25;
/** A run turning less than this in total is straight (radians, 3 degrees). */
const STRAIGHT_ANGLE = (3 * Math.PI) / 180;

/** Absolute turning angle at `b` between a->b and b->c. @pure */
function turnAt(a: Vec2, b: Vec2, c: Vec2): number {
  const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
  return Math.abs(Math.atan2(cross, dot));
}

const distance = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Is `points[i]` an interior vertex of a tessellated curve rather than a corner? Its turn is below
 * CORNER_ANGLE, equals its neighbours' turns and its two chords are about equally long (a regular
 * arc, however coarse); a lone bend or a bend between unequal segments is a real corner. @pure
 */
function isSmoothVertex(at: (i: number) => Vec2, i: number, hasPrev: boolean, hasNext: boolean): boolean {
  const turn = turnAt(at(i - 1), at(i), at(i + 1));
  if (turn >= CORNER_ANGLE) return false;
  const [before, after] = [distance(at(i - 1), at(i)), distance(at(i), at(i + 1))];
  if (Math.max(before, after) > CHORD_RATIO * Math.min(before, after)) return false;
  const neighbours = [...(hasPrev ? [turnAt(at(i - 2), at(i - 1), at(i))] : []), ...(hasNext ? [turnAt(at(i), at(i + 1), at(i + 2))] : [])];
  const margin = Math.max(turn * TURN_MATCH, TURN_MATCH_MIN);
  return neighbours.length > 0 && neighbours.every((t) => Math.abs(t - turn) <= margin);
}

interface Run {
  readonly points: Vec2[];
  readonly closed: boolean;
}

/** Splits a chain at its corners; a smooth closed chain stays one closed run. */
function chainRuns(chain: SegmentChain<Vec2>): { corners: Vec2[]; runs: Run[] } {
  const { points, closed } = chain;
  const count = points.length;
  const at = (i: number): Vec2 => points[((i % count) + count) % count] as Vec2;
  const cornerIndices: number[] = [];
  for (let i = closed ? 0 : 1; i < (closed ? count : count - 1); i++) {
    const hasPrev = closed || i >= 2;
    const hasNext = closed || i + 2 < count;
    if (!isSmoothVertex(at, i, hasPrev, hasNext)) cornerIndices.push(i);
  }
  if (closed) {
    if (cornerIndices.length === 0) return { corners: [], runs: [{ points, closed: true }] };
    const runs = cornerIndices.map((from, k): Run => {
      const to = (cornerIndices[(k + 1) % cornerIndices.length] as number) + (k + 1 === cornerIndices.length ? count : 0);
      return {
        points: Array.from({ length: to - from + 1 }, (_, j) => at(from + j)),
        closed: false,
      };
    });
    return { corners: cornerIndices.map(at), runs };
  }
  const breaks = [0, ...cornerIndices, count - 1];
  const runs = breaks.slice(1).map((to, k): Run => ({ points: points.slice(breaks[k] as number, to + 1), closed: false }));
  return { corners: breaks.map(at), runs };
}

/** Total absolute turning along a run (interior vertices; all vertices when closed). */
function totalTurn({ points, closed }: Run): number {
  const count = points.length;
  let sum = 0;
  for (let i = closed ? 0 : 1; i < (closed ? count : count - 1); i++) {
    sum += turnAt(points[(i - 1 + count) % count] as Vec2, points[i] as Vec2, points[(i + 1) % count] as Vec2);
  }
  return sum;
}

/** Extreme x / y points of a smooth run; an extreme sitting on an open run's end is already an endpoint. */
function quadrantPoints(run: Run, tolerance: number): Vec2[] {
  const { points, closed } = run;
  const quadrants: Vec2[] = [];
  for (const axis of [0, 1] as const) {
    for (const sign of [1, -1]) {
      const best = Math.max(...points.map((p) => sign * p[axis]));
      const tied = points.flatMap((p, i) => (sign * p[axis] >= best - tolerance * 10 ? [i] : []));
      if (!closed && (tied.includes(0) || tied.includes(points.length - 1))) continue;
      const mean = (dimension: 0 | 1): number => tied.reduce((sum, i) => sum + (points[i] as Vec2)[dimension], 0) / tied.length;
      quadrants.push([mean(0), mean(1)]);
    }
  }
  return quadrants;
}

function chainSnaps(chain: SegmentChain<Vec2>, tolerance: number): SnapPoint[] {
  const snaps: SnapPoint[] = [];
  const { corners, runs } = chainRuns(chain);
  for (const [x, y] of corners) snaps.push({ x, y, type: 'endpoint' });
  for (const run of runs) {
    if (!run.closed && totalTurn(run) < STRAIGHT_ANGLE) {
      const [a, b] = [run.points[0] as Vec2, run.points[run.points.length - 1] as Vec2];
      snaps.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, type: 'midpoint' });
    } else {
      for (const [x, y] of quadrantPoints(run, tolerance)) snaps.push({ x, y, type: 'endpoint' });
    }
  }
  return snaps;
}

interface CentreLine {
  readonly middle: Vec2;
  /** Unit direction. */
  readonly direction: Vec2;
}

/** Crossing of each pair of perpendicular centre lines sharing a midpoint. */
function centreMarkSnaps(primitives: ReadonlyArray<DrawingPrimitive>, tolerance: number): SnapPoint[] {
  const lines: CentreLine[] = [];
  for (const primitive of primitives) {
    if (primitive.type !== 'line' || primitive.style !== 'center') continue;
    const [dx, dy] = [primitive.b[0] - primitive.a[0], primitive.b[1] - primitive.a[1]];
    const length = Math.hypot(dx, dy);
    if (length <= tolerance) continue;
    lines.push({
      middle: [(primitive.a[0] + primitive.b[0]) / 2, (primitive.a[1] + primitive.b[1]) / 2],
      direction: [dx / length, dy / length],
    });
  }
  const snaps: SnapPoint[] = [];
  lines.forEach((line, i) => {
    const crossed = lines
      .slice(i + 1)
      .some(
        (other) =>
          Math.hypot(other.middle[0] - line.middle[0], other.middle[1] - line.middle[1]) <= tolerance * 10 &&
          Math.abs(line.direction[0] * other.direction[0] + line.direction[1] * other.direction[1]) < 1e-3,
      );
    if (crossed) snaps.push({ x: line.middle[0], y: line.middle[1], type: 'center' });
  });
  return snaps;
}

/** Snap points of a solid's drawing, one per location and type. @pure */
export function drawingSnapPoints(primitives: ReadonlyArray<DrawingPrimitive>): SnapPoint[] {
  const tolerance = drawingTolerance(primitives);
  const all = [...drawingChains(primitives).flatMap((chain) => chainSnaps(chain, tolerance)), ...centreMarkSnaps(primitives, tolerance)];
  const seen = new Set<string>();
  return all.filter(({ x, y, type }) => {
    const key = `${type}:${quantizedKey([x, y], tolerance * 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
