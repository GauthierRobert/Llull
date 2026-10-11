/**
 * Stair plan frame.
 * @layer domain-aec
 */

import type { StairElement } from '@core/model/building';
import type { Vec2 } from '@core/model/types';

/** Plan point `along` the run from the stair start and `across` it (left of travel positive). */
export function stairPoint(stair: StairElement, along: number, across: number): Vec2 {
  const [cos, sin] = [Math.cos(stair.angle), Math.sin(stair.angle)];
  return [stair.start[0] + cos * along - sin * across, stair.start[1] + sin * along + cos * across];
}
