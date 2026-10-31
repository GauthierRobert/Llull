/** Sheet geometry of the authoring commands (plant 04 PID §5.3): route legs, split at an inline item, heal, orthogonal auto-route. Millimetres. */

import type { Vec2 } from '@core/model/vectors';

/** Tolerance for "same point" (mm). */
export const EPS = 1e-6;
/** Half symbol length of an inline item: its two ports lie g mm either side of the insertion point (§5.3). */
export const INLINE_HALF_LENGTH = 5;
/** A point farther than this from a line is "off the line" (§5.3, `PID_POINT_OFF_LINE`). */
export const SNAP_DISTANCE = 5;

export const samePoint = (a: Vec2, b: Vec2, eps = EPS): boolean => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Route without consecutive duplicate points. */
export function dedupe(route: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const point of route) {
    const last = out[out.length - 1];
    if (last === undefined || !samePoint(last, point)) out.push(point);
  }
  return out;
}

/** Point `b` lies on the straight line through `a` and `c` (perpendicular distance <= `tolerance` mm). */
export function colinear(a: Vec2, b: Vec2, c: Vec2, tolerance = 1e-9): boolean {
  const length = distance(a, c);
  if (length === 0) return samePoint(a, b);
  return Math.abs((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / length <= tolerance;
}

export interface LegHit {
  /** Index of the leg (route[leg] -> route[leg + 1]). */
  readonly leg: number;
  /** Distance of the point to the leg, mm. */
  readonly distance: number;
  /** The point projected onto the leg. */
  readonly snapped: Vec2;
  /** Distance of the snapped point from route[leg], mm. */
  readonly along: number;
  readonly legLength: number;
  /** Unit direction of the leg. */
  readonly direction: Vec2;
}

/** Nearest leg of `route` to `point` (first minimum); undefined for a route without a leg of length > 0. */
export function nearestLeg(route: readonly Vec2[], point: Vec2): LegHit | undefined {
  let best: LegHit | undefined;
  for (let leg = 0; leg + 1 < route.length; leg++) {
    const a = route[leg];
    const b = route[leg + 1];
    if (a === undefined || b === undefined) continue;
    const legLength = distance(a, b);
    if (legLength === 0) continue;
    const direction: Vec2 = [(b[0] - a[0]) / legLength, (b[1] - a[1]) / legLength];
    const along = Math.min(legLength, Math.max(0, (point[0] - a[0]) * direction[0] + (point[1] - a[1]) * direction[1]));
    const snapped: Vec2 = [a[0] + direction[0] * along, a[1] + direction[1] * along];
    const d = distance(point, snapped);
    if (best === undefined || d < best.distance) best = { leg, distance: d, snapped, along, legLength, direction };
  }
  return best;
}

export interface SplitRoute {
  readonly first: Vec2[];
  readonly second: Vec2[];
  readonly ports: [Vec2, Vec2];
}

/** Splits `route` at the hit (§5.3): R1 = R[0..k] + p - g u, R2 = p + g u + R[k+1..]; the ports are the two new ends. */
export function splitRoute(route: readonly Vec2[], hit: LegHit, half = INLINE_HALF_LENGTH): SplitRoute {
  const [ux, uy] = hit.direction;
  const p = hit.snapped;
  const before: Vec2 = [p[0] - ux * half, p[1] - uy * half];
  const after: Vec2 = [p[0] + ux * half, p[1] + uy * half];
  return {
    first: dedupe([...route.slice(0, hit.leg + 1), before]),
    second: dedupe([after, ...route.slice(hit.leg + 1)]),
    ports: [before, after],
  };
}

/** Joins two routes through an inline item that is removed: junction points at its ports are dropped when colinear (restores R exactly, VC-PID-13). */
export function healRoutes(first: readonly Vec2[], second: readonly Vec2[], ports: readonly Vec2[]): Vec2[] {
  const merged = dedupe([...first, ...second]);
  const isPort = (point: Vec2): boolean => ports.some((port) => samePoint(port, point));
  const out: Vec2[] = [];
  merged.forEach((point, index) => {
    const previous = out[out.length - 1];
    const next = merged[index + 1];
    if (previous !== undefined && next !== undefined && isPort(point) && colinear(previous, point, next)) return;
    out.push(point);
  });
  return out;
}

export type Axis = 'h' | 'v';

/** Exit axis of a port relative to the centre of its equipment: the dominant axis of the offset. */
export const axisOf = (from: Vec2, port: Vec2): Axis => (Math.abs(port[1] - from[1]) > Math.abs(port[0] - from[0]) ? 'v' : 'h');

/** Orthogonal route between two points: straight when aligned, else an L (axes differ or the end is free) or a Z (same axis). */
export function orthogonalRoute(start: Vec2, end: Vec2, startAxis: Axis | undefined, endAxis: Axis | undefined): Vec2[] {
  if (Math.abs(start[0] - end[0]) <= EPS || Math.abs(start[1] - end[1]) <= EPS) return dedupe([start, end]);
  const first = startAxis ?? 'h';
  if (endAxis === first) {
    const mid: Vec2 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    return first === 'h'
      ? dedupe([start, [mid[0], start[1]], [mid[0], end[1]], end])
      : dedupe([start, [start[0], mid[1]], [end[0], mid[1]], end]);
  }
  return dedupe([start, first === 'h' ? [end[0], start[1]] : [start[0], end[1]], end]);
}

/** Axis of the leg of `route` that touches the start (`atStart`) or end of the route. */
function endAxisOf(route: readonly Vec2[], atStart: boolean): Axis | undefined {
  const end = atStart ? route[0] : route[route.length - 1];
  const neighbour = atStart ? route[1] : route[route.length - 2];
  if (end === undefined || neighbour === undefined) return undefined;
  return Math.abs(end[1] - neighbour[1]) <= EPS ? 'h' : Math.abs(end[0] - neighbour[0]) <= EPS ? 'v' : undefined;
}

/** Moves one end of `route` to `point`, adding an elbow so the leg next to it keeps its axis (an end leg is re-routed, the rest is untouched). */
export function moveRouteEnd(route: readonly Vec2[], atStart: boolean, point: Vec2): Vec2[] {
  const axis = endAxisOf(route, atStart);
  const neighbour = atStart ? route[1] : route[route.length - 2];
  if (neighbour === undefined) return [...route];
  const rest = atStart ? route.slice(1) : route.slice(0, -1);
  let elbow: Vec2 | undefined;
  if (axis === 'h' && Math.abs(point[1] - neighbour[1]) > EPS) elbow = [point[0], neighbour[1]];
  else if (axis === 'v' && Math.abs(point[0] - neighbour[0]) > EPS) elbow = [neighbour[0], point[1]];
  const moved = atStart ? [point, ...(elbow ? [elbow] : []), ...rest] : [...rest, ...(elbow ? [elbow] : []), point];
  return dedupe(moved);
}
