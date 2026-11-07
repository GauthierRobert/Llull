/** Area enclosed by a closed 2D shape. */

import type { Entity } from '../model/types';
import { polygonArea } from '../lib/polygon';
import { regionNetArea } from './region';

/**
 * Enclosed area of a rectangle, circle, ellipse, closed polyline (>= 3 points) or region (net: outer minus holes plus islands, exact over its curves), in the shape's local plane; null for every other entity
 * (open or degenerate polylines included).
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
    case 'region':
      return regionNetArea(entity);
    default:
      return null;
  }
}
