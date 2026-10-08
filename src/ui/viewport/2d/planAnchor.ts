/**
 * @layer ui/viewport/2d
 * Float32-safe origin for a building plan: all plan vertices are stored relative to the first
 * primitive's first point and the group is positioned at that point (float64 on the CPU).
 */

import type { Vec2 } from '@core/model/types';
import type { PlanPrimitive } from '@aec/index';

/**
 * First XY point found in `primitives`, or [0, 0] when there is none.
 * @pure
 */
export function planAnchor(primitives: ReadonlyArray<PlanPrimitive>): Vec2 {
  for (const primitive of primitives) {
    switch (primitive.type) {
      case 'polygon':
      case 'polyline':
        if (primitive.points[0]) return primitive.points[0];
        break;
      case 'line':
      case 'dimension':
        return primitive.a;
      case 'arc':
      case 'circle':
        return primitive.center;
      case 'text':
        return primitive.at;
    }
  }
  return [0, 0];
}
