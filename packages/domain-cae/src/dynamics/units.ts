/** Standard gravity in the acceleration unit of each analysis unit system (g = 9.80665 m/s^2, CGPM 1901). */

import type { UnitSystem } from '@core/model/analysis';
import { unitSystemFactors } from '../decks/units';
import { STANDARD_GRAVITY } from './math/sdof';

/** g in mm/s^2 (N-mm-t-s), m/s^2 (N-m-kg-s) or in/s^2 (lbf-in-slinch-s). */
export function gravityInUnitSystem(unitSystem: UnitSystem): number {
  if (unitSystem === 'N-mm-t-s') return STANDARD_GRAVITY * 1000;
  return STANDARD_GRAVITY / unitSystemFactors(unitSystem).metresPerLength;
}
