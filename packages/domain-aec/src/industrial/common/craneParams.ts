/**
 * Crane parameters shared by the runway, bracing and portal-frame checks: schema fields and validation.
 * @layer domain-aec
 * @pure
 */

import { z } from '@core/commands/schema';
import { isNonNegativeNumber } from '@lib/isFiniteNumber';
import { firstNonPositive } from '../../shared/numeric';

export const hoistingClassField = z
  .enum(['HC1', 'HC2', 'HC3', 'HC4'])
  .optional()
  .describe(
    'EN 1991-3 hoisting class for the dynamic factor φ2 = φ2,min + β2 vh (HC1 1.05 + 0.17 vh, ' +
      'HC2 1.10 + 0.34 vh, HC3 1.15 + 0.51 vh, HC4 1.20 + 0.68 vh). Default HC2.',
  );

export const hoistingSpeedField = z.number().optional().describe('Hoisting speed vh in m/s (>= 0) for φ2. Default 0.1.');

export const craneSelfWeightField = z
  .number()
  .optional()
  .describe('Crane self-weight Gc in kN (> 0, bridge + trolley; trolley = 0.2 Gc). Default 0.5 Q + 20 kN.');

export const minHookApproachField = z
  .number()
  .optional()
  .describe('Minimum approach of the hook to a rail in m (>= 0): the trolley position that maximises the wheel load. Default 1.0.');

export const wheelBaseField = z
  .number()
  .optional()
  .describe(
    'Wheel base a of a crane rail wheel group (distance between its two wheels) in mm (> 0), used for the transverse drive force HT = φ5 ξ M / a. Default 3000.',
  );

export const travelSpeedField = z
  .number()
  .optional()
  .describe('Crane long travel speed in m/s (> 0) for the buffer force HB,1 (v1 = 0.7 × travelSpeed). Default 0.63 (about 38 m/min).');

export const bufferStiffnessField = z
  .number()
  .optional()
  .describe('Buffer spring constant SB in kN/m (> 0) for HB,1 = φ7 v1 √(mc SB). Default 1000 kN/m.');

type CraneValues = Partial<
  Record<
    | 'craneCapacity'
    | 'craneSpan'
    | 'craneSelfWeight'
    | 'wheelBase'
    | 'travelSpeed'
    | 'bufferStiffness'
    | 'hoistingSpeed'
    | 'minHookApproach',
    number | undefined
  >
>;

/** `<name> must be a number > 0|>= 0` for the first given crane value out of range, else undefined. */
export function craneValueProblem(values: CraneValues): string | undefined {
  const positive = firstNonPositive([
    ['craneCapacity', values.craneCapacity],
    ['craneSpan', values.craneSpan],
    ['craneSelfWeight', values.craneSelfWeight],
    ['wheelBase', values.wheelBase],
    ['travelSpeed', values.travelSpeed],
    ['bufferStiffness', values.bufferStiffness],
  ]);
  if (positive !== undefined) return `${positive} must be a number > 0`;
  const negative = (['hoistingSpeed', 'minHookApproach'] as const).find(
    (name) => values[name] !== undefined && !isNonNegativeNumber(values[name]),
  );
  return negative === undefined ? undefined : `${negative} must be a number >= 0`;
}
