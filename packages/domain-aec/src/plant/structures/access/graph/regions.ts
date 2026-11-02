/** Plan geometry of the access graph (06 STA §5.7): walking-surface regions in millimetres, boxes and distances. Pure. */

import type { Vec2 } from '@core/model/types';
import { pointInPolygon, projectOntoSegment, segmentsIntersect } from '@lib/polygon';

export type Ring = ReadonlyArray<Vec2>;
/** Axis-aligned box `[minX, minY, maxX, maxY]`. */
export type Box = readonly [number, number, number, number];

/** A polygon with its holes (stair wells, equipment cut-outs). */
export interface Region {
  readonly outer: Ring;
  readonly holes: ReadonlyArray<Ring>;
  readonly box: Box;
}

export function boxOf(ring: Ring): Box {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

export const unionBox = (boxes: ReadonlyArray<Box>): Box =>
  boxes.reduce<Box>(
    (all, box) => [Math.min(all[0], box[0]), Math.min(all[1], box[1]), Math.max(all[2], box[2]), Math.max(all[3], box[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );

/** True when the boxes are within `margin` of each other. */
export const boxesNear = (a: Box, b: Box, margin: number): boolean =>
  a[0] <= b[2] + margin && b[0] <= a[2] + margin && a[1] <= b[3] + margin && b[1] <= a[3] + margin;

/** Distance from `point` to the box (0 inside). */
export const distanceToBox = (point: Vec2, box: Box): number =>
  Math.hypot(Math.max(box[0] - point[0], 0, point[0] - box[2]), Math.max(box[1] - point[1], 0, point[1] - box[3]));

export function makeRegion(outer: Ring, holes: ReadonlyArray<Ring> = []): Region {
  return { outer, holes, box: boxOf(outer) };
}

/** Plan distance from `point` to the boundary of `ring` (never 0 unless on it). */
function distanceToEdges(point: Vec2, ring: Ring): number {
  let nearest = Infinity;
  for (let index = 0; index < ring.length; index++)
    nearest = Math.min(nearest, projectOntoSegment(point, ring[index] as Vec2, ring[(index + 1) % ring.length] as Vec2).distance);
  return nearest;
}

/** Plan distance from `point` to the material of the region: 0 on it, to the hole edge inside a hole, to the outline outside. */
export function distanceToRegion(point: Vec2, region: Region): number {
  if (!pointInPolygon(point, region.outer)) return distanceToEdges(point, region.outer);
  const hole = region.holes.find((ring) => pointInPolygon(point, ring));
  return hole === undefined ? 0 : distanceToEdges(point, hole);
}

/** Distance between two segments: 0 when they cross or touch. */
function segmentDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    projectOntoSegment(a1, b1, b2).distance,
    projectOntoSegment(a2, b1, b2).distance,
    projectOntoSegment(b1, a1, a2).distance,
    projectOntoSegment(b2, a1, a2).distance,
  );
}

/**
 * True when the outlines of two rings are within `tolerance` of each other or overlap (one inside the other counts). Early exit on the first pair
 * within tolerance, so touching panels are cheap.
 */
export function ringsWithin(a: Ring, b: Ring, tolerance: number): boolean {
  const [boxA, boxB] = [boxOf(a), boxOf(b)];
  if (!boxesNear(boxA, boxB, tolerance)) return false;
  if (a.some((point) => pointInPolygon(point, b)) || b.some((point) => pointInPolygon(point, a))) return true;
  for (let i = 0; i < a.length; i++) {
    const [a1, a2] = [a[i] as Vec2, a[(i + 1) % a.length] as Vec2];
    for (let j = 0; j < b.length; j++) if (segmentDistance(a1, a2, b[j] as Vec2, b[(j + 1) % b.length] as Vec2) <= tolerance) return true;
  }
  return false;
}

/** Smallest width of the convex hull of the points: the least extent across any edge direction of the polygon (exact for a convex polygon). */
export function minimumWidth(ring: Ring): number {
  let least = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const [a, b] = [ring[index] as Vec2, ring[(index + 1) % ring.length] as Vec2];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) continue;
    const normal: Vec2 = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
    const projections = ring.map((point) => (point[0] - a[0]) * normal[0] + (point[1] - a[1]) * normal[1]);
    least = Math.min(least, Math.max(...projections) - Math.min(...projections));
  }
  return least;
}
