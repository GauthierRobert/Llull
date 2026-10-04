/**
 * Curved wall geometry: arc through three points, plan band, evaluated mesh.
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel, CurvedWallElement, WallElement } from '@core/model/building';
import type { Vec2 } from '@core/model/types';
import { toCounterClockwise } from '@lib/polygon';
import type { WallExtent } from './wallGeometry';

/** Circle arc through three points: centre, radius, start angle and signed sweep (radians). */
export interface Arc {
  readonly center: Vec2;
  readonly radius: number;
  readonly startAngle: number;
  readonly sweep: number;
}

/** @failure collinear or coincident points -> null */
export function arcThrough(start: Vec2, through: Vec2, end: Vec2): Arc | null {
  const [ax, ay] = start;
  const [bx, by] = through;
  const [cx, cy] = end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const scale = Math.max(Math.hypot(cx - ax, cy - ay), Math.hypot(bx - ax, by - ay));
  if (!(scale > 0) || Math.abs(d) < 1e-9 * scale * scale) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const center: Vec2 = [
    (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
    (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
  ];
  const angle = ([x, y]: Vec2): number => Math.atan2(y - center[1], x - center[0]);
  const turn = (from: number, to: number): number => {
    const delta = (to - from) % (2 * Math.PI);
    return delta < 0 ? delta + 2 * Math.PI : delta;
  };
  const startAngle = angle(start);
  const counterClockwise = turn(startAngle, angle(end));
  // The arc runs the way that passes through `through` (d > 0 ⇔ counter-clockwise).
  const sweep = d > 0 ? counterClockwise : counterClockwise - 2 * Math.PI;
  return { center, radius: Math.hypot(ax - center[0], ay - center[1]), startAngle, sweep };
}

export function curvedWallArc(wall: CurvedWallElement): Arc | null {
  return arcThrough(wall.start, wall.through, wall.end);
}

/** Centreline length. */
export function curvedWallLength(wall: CurvedWallElement): number {
  const arc = curvedWallArc(wall);
  return arc ? arc.radius * Math.abs(arc.sweep) : 0;
}

/** Points along an arc of radius `radius` (≈ 5° steps). */
export function arcPoints(arc: Arc, radius: number): Vec2[] {
  const steps = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 36)));
  return Array.from({ length: steps + 1 }, (_, index): Vec2 => {
    const angle = arc.startAngle + (arc.sweep * index) / steps;
    return [arc.center[0] + radius * Math.cos(angle), arc.center[1] + radius * Math.sin(angle)];
  });
}

/** Plan outline of the whole wall (outer arc, then inner arc back), counter-clockwise. */
export function curvedWallBand(wall: CurvedWallElement): Vec2[] | null {
  return curvedBandBetween(wall, 0, curvedWallLength(wall));
}

/** Point and unit travel direction at arc length `s` from the start. */
function arcFrame(arc: Arc, s: number): { point: Vec2; tangent: Vec2 } {
  const angle = arc.startAngle + Math.sign(arc.sweep) * (s / arc.radius);
  const sign = Math.sign(arc.sweep) || 1;
  return {
    point: [
      arc.center[0] + arc.radius * Math.cos(angle),
      arc.center[1] + arc.radius * Math.sin(angle),
    ],
    tangent: [-Math.sin(angle) * sign, Math.cos(angle) * sign],
  };
}

/** Arc length from the start of the point of the arc nearest to `at` (clamped to the arc). */
export function arcOffsetOf(wall: CurvedWallElement, at: Vec2): number {
  const arc = curvedWallArc(wall);
  if (!arc) return 0;
  const angle = Math.atan2(at[1] - arc.center[1], at[0] - arc.center[0]);
  let delta = (angle - arc.startAngle) * Math.sign(arc.sweep);
  delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sweep = Math.abs(arc.sweep);
  // Outside the arc: snap to the nearer end.
  if (delta > sweep) delta = delta - sweep < 2 * Math.PI - delta ? sweep : 0;
  return delta * arc.radius;
}

/**
 * Straight stand-in for a curved wall around arc length `offset`: the tangent there, with the
 * same parametrisation (pointAlong(offset) is the arc point) and the wall's other properties.
 */
export function tangentWall(wall: CurvedWallElement, offset: number): WallElement {
  const arc = curvedWallArc(wall);
  // Ends exactly at the arc end when the offset is clamped there (unit-independent).
  const length = Math.max(curvedWallLength(wall), offset);
  const { point, tangent } = arc
    ? arcFrame(arc, offset)
    : { point: wall.start, tangent: [1, 0] as Vec2 };
  const start: Vec2 = [point[0] - tangent[0] * offset, point[1] - tangent[1] * offset];
  return {
    id: wall.id,
    category: 'wall',
    mark: wall.mark,
    entityIds: [],
    levelId: wall.levelId,
    start,
    end: [start[0] + tangent[0] * length, start[1] + tangent[1] * length],
    thickness: wall.thickness,
    height: wall.height,
    baseOffset: wall.baseOffset,
    material: wall.material,
  };
}

/** Plan band of the wall between arc lengths s0 and s1 (counter-clockwise). */
export function curvedBandBetween(wall: CurvedWallElement, s0: number, s1: number): Vec2[] | null {
  const arc = curvedWallArc(wall);
  if (!arc || wall.thickness / 2 >= arc.radius || !(s1 > s0)) return null;
  const sign = Math.sign(arc.sweep);
  const piece: Arc = {
    ...arc,
    startAngle: arc.startAngle + (sign * s0) / arc.radius,
    sweep: (sign * (s1 - s0)) / arc.radius,
  };
  return toCounterClockwise([
    ...arcPoints(piece, arc.radius + wall.thickness / 2),
    ...arcPoints(piece, arc.radius - wall.thickness / 2).reverse(),
  ]);
}

/**
 * Arc-length interval actually built: each end is cut back where a straight wall closes the
 * corner (that wall extends over the curved wall's end, as in straight L joints).
 */
export function curvedWallExtent(building: BuildingModel, wall: CurvedWallElement): WallExtent {
  const length = curvedWallLength(wall);
  const arc = curvedWallArc(wall);
  if (!arc) return { start: 0, end: length };
  const tolerance = Math.max(wall.thickness * 0.05, 1e-9);
  const trimAt = (offset: number, inward: 1 | -1): number => {
    const { point, tangent } = arcFrame(arc, offset);
    const away: Vec2 = [tangent[0] * inward, tangent[1] * inward];
    for (const id of building.elementOrder) {
      const other = building.elements[id];
      if (other?.category !== 'wall' || other.levelId !== wall.levelId) continue;
      const atStart = Math.hypot(other.start[0] - point[0], other.start[1] - point[1]) <= tolerance;
      const atEnd = Math.hypot(other.end[0] - point[0], other.end[1] - point[1]) <= tolerance;
      if (!atStart && !atEnd) continue;
      const [from, to] = atStart ? [other.start, other.end] : [other.end, other.start];
      const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
      if (span === 0) continue;
      const direction: Vec2 = [(to[0] - from[0]) / span, (to[1] - from[1]) / span];
      const sine = Math.abs(away[0] * direction[1] - away[1] * direction[0]);
      if (sine < 0.05) continue;
      const cosine = Math.abs(away[0] * direction[0] + away[1] * direction[1]);
      return Math.max(0, (other.thickness / 2 - (wall.thickness / 2) * cosine) / sine);
    }
    return 0;
  };
  const start = trimAt(0, 1);
  const end = length - trimAt(length, -1);
  return end > start ? { start, end } : { start: 0, end: length };
}
