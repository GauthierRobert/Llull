/** Angle conventions of plant equipment commands (README D3): `north_cw` (default) and `east_ccw`; stored angles are always `north_cw`. */

import { z } from '@core/commands/schema';

export type AngleConvention = 'north_cw' | 'east_ccw';

export const angleConventionParam = z
  .enum(['north_cw', 'east_ccw'])
  .optional()
  .describe(
    'How angles in this call are read and reported. north_cw (default): vertical equipment 0 = plant north (+Y), growing clockwise seen from ' +
      'above (90 = east, +X); horizontal equipment 0 = top (+Z), 90 = the +Y side; a plan rotation grows clockwise. east_ccw: CAD maths, 0 = east ' +
      '(+X), growing counter-clockwise; horizontal equipment 0 = +Y, 90 = top; a plan rotation grows counter-clockwise. Every result names the convention.',
  );

const normalise = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** North-clockwise degrees (stored form, in [0, 360)) of an angle given in `convention`. */
export const toNorthClockwise = (degrees: number, convention: AngleConvention): number =>
  normalise(convention === 'north_cw' ? degrees : 90 - degrees);

/** The same angle expressed in `convention`, in [0, 360) (the conversion is its own inverse). */
export const fromNorthClockwise = toNorthClockwise;

/** Plan rotation (element.angle, radians, counter-clockwise from above) of a rotation given in `convention`. */
export const planRotationRadians = (degrees: number, convention: AngleConvention): number =>
  ((convention === 'north_cw' ? -degrees : degrees) * Math.PI) / 180;

/** Plan rotation of `radians` (counter-clockwise) in the degrees of `convention`. */
export const planRotationDegrees = (radians: number, convention: AngleConvention): number =>
  ((convention === 'north_cw' ? -radians : radians) * 180) / Math.PI;
