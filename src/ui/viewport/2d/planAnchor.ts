// Float32-safe plan origin: vertices relative to the first primitive's first point, the group placed there.

import type { Vec2 } from '@core/model/types';
import type { DrawingPrimitive } from '@core/model/drawing';

/** First XY point found in `primitives`, or [0, 0] when there is none. */
export function planAnchor(primitives: ReadonlyArray<DrawingPrimitive>): Vec2 {
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
