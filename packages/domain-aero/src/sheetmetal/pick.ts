/** Picking flats and edges of a part by a world point (the `near` convention: re-resolved on every replay). */

import type { Vec2, Vec3 } from '@core/model/types';
import type { SheetMetalPart } from '@core/model/sheetMetal';
import { pointInPolygon, projectOntoSegment } from '@lib/polygon';
import { bottomOffset, worldToFrame } from './frames';
import { type FlatNode, flatsOf } from './graph';

export interface FlatHit {
  readonly flat: FlatNode;
  /** The point in the flat's own plane coordinates. */
  readonly local: Vec2;
  /** Distance from the point to the flat's material slab (0 inside the polygon and slab). */
  readonly distance: number;
}

export interface EdgeHit extends FlatHit {
  readonly index: number;
  /** Edge end points a -> b (counter-clockwise outline order). */
  readonly a: Vec2;
  readonly b: Vec2;
}

const slabGap = (z: number, bottom: number, thickness: number): number => Math.max(0, bottom - z, z - (bottom + thickness));

function edgeDistance(polygon: readonly Vec2[], point: Vec2): { index: number; distance: number } {
  let best = { index: 0, distance: Infinity };
  polygon.forEach((a, index) => {
    const distance = projectOntoSegment(point, a, polygon[(index + 1) % polygon.length] as Vec2).distance;
    if (distance < best.distance - 1e-12) best = { index, distance };
  });
  return best;
}

/** The flat whose material slab is nearest `near` (inside the outline counts as distance 0 in-plane). */
export function pickFlat(part: SheetMetalPart, thickness: number, near: Vec3): FlatHit | null {
  const bottom = bottomOffset(part.side, thickness);
  let best: FlatHit | null = null;
  for (const flat of flatsOf(part)) {
    const [x, y, z] = worldToFrame(flat.frame, near);
    const local: Vec2 = [x, y];
    const inPlane = pointInPolygon(local, flat.outline) ? 0 : edgeDistance(flat.outline, local).distance;
    const distance = Math.hypot(inPlane, slabGap(z, bottom, thickness));
    if (best === null || distance < best.distance - 1e-12) best = { flat, local, distance };
  }
  return best;
}

/** The outline edge (over all flats) nearest `near`, by distance to the edge segment and the material slab. */
export function pickEdge(part: SheetMetalPart, thickness: number, near: Vec3): EdgeHit | null {
  const bottom = bottomOffset(part.side, thickness);
  let best: EdgeHit | null = null;
  for (const flat of flatsOf(part)) {
    const [x, y, z] = worldToFrame(flat.frame, near);
    const { index, distance } = edgeDistance(flat.outline, [x, y]);
    const total = Math.hypot(distance, slabGap(z, bottom, thickness));
    if (best === null || total < best.distance - 1e-12)
      best = {
        flat,
        local: [x, y],
        distance: total,
        index,
        a: flat.outline[index] as Vec2,
        b: flat.outline[(index + 1) % flat.outline.length] as Vec2,
      };
  }
  return best;
}
