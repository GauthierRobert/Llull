/**
 * Curved wall geometry: arc through three points, plan band, evaluated mesh.
 * @layer core/commands/building
 * @pure
 */

import type { BuildingLevel, CurvedWallElement } from '../../model/building';
import type { Entity, Vec2 } from '../../model/types';
import { toCounterClockwise } from '../../../lib/polygon';
import { colorForMaterial, meshEntity } from './entities';
import { prismMesh } from './mesh';

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

/** Plan outline of the wall (outer arc, then inner arc back), counter-clockwise. */
export function curvedWallBand(wall: CurvedWallElement): Vec2[] | null {
  const arc = curvedWallArc(wall);
  if (!arc || wall.thickness / 2 >= arc.radius) return null;
  return toCounterClockwise([
    ...arcPoints(arc, arc.radius + wall.thickness / 2),
    ...arcPoints(arc, arc.radius - wall.thickness / 2).reverse(),
  ]);
}

export function evaluateCurvedWall(wall: CurvedWallElement, level: BuildingLevel): Entity[] {
  const band = curvedWallBand(wall);
  if (!band) return [];
  const bottom = level.elevation + wall.baseOffset;
  const mesh = prismMesh(band, [], ([x, y], side) => [x, y, bottom + side * wall.height]);
  return mesh
    ? [
        meshEntity(
          wall,
          { part: 'body', label: `Wall ${wall.mark}` },
          mesh,
          colorForMaterial(wall.material, '#c9c4b8'),
        ),
      ]
    : [];
}
