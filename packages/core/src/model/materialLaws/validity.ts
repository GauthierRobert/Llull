/** Validity ranges of a material model: base unit per variable and well-formedness (data ⊆ equation, unit of the right dimension). */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import type { MaterialValidityVariable, MaterialValidRange } from '../materialModel';
import { error, type MatlIssue } from './issues';

export const VALIDITY_BASE_UNIT: Readonly<Record<MaterialValidityVariable, string>> = {
  T: 'K',
  strainRate: '1/s',
  time: 's',
  exposureTime: 's',
  pressure: 'MPa',
  equivalentPlasticStrain: '1',
  stretch: '1',
};

/** First problem of a list of validity ranges (PROP_RANGE_INVALID: bounds ordered, equation ⊇ data, unit of the variable's dimension, one range per variable). */
export function validityIssue(validity: readonly MaterialValidRange[]): MatlIssue | null {
  const seen = new Set<string>();
  for (const [i, range] of validity.entries()) {
    const path = `validity[${i}]`;
    if (seen.has(range.variable)) return error('PROP_RANGE_INVALID', path, `variable ${range.variable} has two ranges`);
    seen.add(range.variable);
    if (isUnitFailure(convertValue(1, range.unit, VALIDITY_BASE_UNIT[range.variable])))
      return error(
        'PROP_RANGE_INVALID',
        `${path}.unit`,
        `unit '${range.unit}' does not match ${range.variable} (${VALIDITY_BASE_UNIT[range.variable]})`,
      );
    const [low, high] = range.data;
    const [equationLow, equationHigh] = range.equation ?? range.data;
    if (!(low <= high) || !(equationLow <= low) || !(equationHigh >= high))
      return error('PROP_RANGE_INVALID', path, 'need data min ≤ max and the equation range ⊇ the data range');
  }
  return null;
}
