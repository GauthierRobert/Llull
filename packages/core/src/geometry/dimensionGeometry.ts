/**
 * Model-space geometry of an aligned dimension primitive — extension lines, dimension line, oblique
 * ticks and the value's placement. The one construction the 2D view and DXF draw (sheets draw the
 * same construction in paper space, `paperDimension`).
 * @layer geometry
 * @pure
 */

import type { Vec2 } from '../model/vectors';
import type { DrawingPrimitive } from '../model/drawing';
import { readableAngle } from '../lib/angle';

type Dimension = Extract<DrawingPrimitive, { type: 'dimension' }>;

export interface DimensionGeometry {
  /** Extension lines, the dimension line and the two ticks. */
  readonly segments: Array<readonly [Vec2, Vec2]>;
  /** Value text: centre point, direction (readable, radians) and height. */
  readonly label: { readonly at: Vec2; readonly angle: number; readonly height: number };
}

export function dimensionGeometry(primitive: Dimension): DimensionGeometry {
  const dx = primitive.b[0] - primitive.a[0];
  const dy = primitive.b[1] - primitive.a[1];
  const length = Math.hypot(dx, dy) || 1;
  const normal: Vec2 = [dy / length, -dx / length];
  const shift = (point: Vec2, distance: number): Vec2 => [
    point[0] + normal[0] * distance,
    point[1] + normal[1] * distance,
  ];
  const { offset } = primitive;
  const a = shift(primitive.a, offset);
  const b = shift(primitive.b, offset);
  const tick = offset * 0.12;
  const segments: Array<readonly [Vec2, Vec2]> = [
    [shift(primitive.a, offset * 0.15), shift(primitive.a, offset * 1.1)],
    [shift(primitive.b, offset * 0.15), shift(primitive.b, offset * 1.1)],
    [a, b],
    ...[a, b].map((end): readonly [Vec2, Vec2] => [
      [end[0] - tick, end[1] - tick],
      [end[0] + tick, end[1] + tick],
    ]),
  ];
  const angle = readableAngle(Math.atan2(dy, dx));
  const lift = offset * 0.22;
  return {
    segments,
    label: {
      at: [(a[0] + b[0]) / 2 - Math.sin(angle) * lift, (a[1] + b[1]) / 2 + Math.cos(angle) * lift],
      angle,
      height: offset * 0.25,
    },
  };
}
