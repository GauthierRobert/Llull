/** Placement tests of features on a flat: polygon contact and clearance to the flat's outline, cutouts and existing beads. */

import type { Vec2 } from '@core/model/types';
import { pointInPolygon, projectOntoSegment } from '@lib/polygon';
import { type FlatNode, type FormNode } from './graph';
import { beadFootprint, beadGeometry } from './formGeometry';
import { polygonToSegmentDistance } from './geometry2d';

/** True when the closed polygons `a` and `b` share any point (edge contact or containment). */
export const polygonsTouch = (a: readonly Vec2[], b: readonly Vec2[]): boolean =>
  a.some((point, i) => polygonToSegmentDistance(b, point, a[(i + 1) % a.length] as Vec2) < 1e-9) ||
  a.some((point) => pointInPolygon(point, b)) ||
  b.some((point) => pointInPolygon(point, a));

/** True when `polygon` lies inside the flat outline with at least `margin` clearance to every outline edge. */
export function insideOutline(flat: FlatNode, polygon: readonly Vec2[], margin: number): boolean {
  return (
    polygon.every((point) => pointInPolygon(point, flat.outline)) &&
    flat.outline.every((a, i) => polygonToSegmentDistance(polygon, a, flat.outline[(i + 1) % flat.outline.length] as Vec2) >= margin)
  );
}

/** Footprints (CCW polygons) of the beads already placed on the flat. */
export function beadFootprints(forms: readonly FormNode[], flatId: string, thickness: number): Vec2[][] {
  return forms.flatMap(({ on, form }): Vec2[][] => {
    if (on !== flatId || form.kind !== 'bead') return [];
    const bead = beadGeometry(form, thickness);
    return bead === null ? [] : [beadFootprint(form.start, form.end, bead.halfWidth, form.endShape)];
  });
}

/** True when every edge of the closed polygon is at least `distance` from `point`. */
export const polygonDistanceAtLeast = (polygon: readonly Vec2[], point: Vec2, distance: number): boolean =>
  polygon.every((a, i) => projectOntoSegment(point, a, polygon[(i + 1) % polygon.length] as Vec2).distance >= distance);

/** True when the disc (`center`, `radius`) lies inside the flat outline, `margin` clear of its edges and of every cutout. */
export function discClear(flat: FlatNode, center: Vec2, radius: number, margin: number): boolean {
  if (!pointInPolygon(center, flat.outline) || !polygonDistanceAtLeast(flat.outline, center, radius + margin)) return false;
  return flat.cutouts.every((cutout) =>
    cutout.circle !== undefined
      ? Math.hypot(cutout.circle.center[0] - center[0], cutout.circle.center[1] - center[1]) >= cutout.circle.radius + radius + margin
      : !pointInPolygon(center, cutout.points) && polygonDistanceAtLeast(cutout.points, center, radius + margin),
  );
}
