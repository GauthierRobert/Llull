/** Area enclosed by a closed 2D shape. */

import type { Entity } from '../model/types';
import { polygonArea } from '../lib/polygon';

/**
 * Enclosed area of a rectangle, circle, ellipse or closed polyline (>= 3 points), in the shape's
 * local plane; null for every other entity (open or degenerate polylines included).
 */
export function closedShapeArea(entity: Entity): number | null {
  switch (entity.kind) {
    case 'rectangle':
      return entity.width * entity.height;
    case 'circle':
      return Math.PI * entity.radius * entity.radius;
    case 'ellipse':
      return Math.PI * entity.radiusX * entity.radiusY;
    case 'polyline':
      return entity.closed && entity.points.length >= 3 ? polygonArea(entity.points) : null;
    default:
      return null;
  }
}
