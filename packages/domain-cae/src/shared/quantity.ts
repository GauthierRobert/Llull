/** Validation of `{ value, unit }` quantities used by the analysis set-up. */

import type { Q } from '@core/model/analysis';
import { isUnitFailure, parseUnit, sameDimension, type Dimension } from '@lib/quantity';

const TEMPERATURE: Dimension = [0, 0, 0, 1, 0, 0, 0];

/** Problem text when `q` is not a finite absolute temperature with a known temperature unit, else null. */
export function temperatureProblem(q: Q): string | null {
  if (!Number.isFinite(q.value)) return 'the temperature value must be a finite number';
  const parsed = parseUnit(q.unit);
  if (isUnitFailure(parsed)) return `unit '${q.unit}': ${parsed.message}`;
  if (!sameDimension(parsed.dimension, TEMPERATURE)) return `unit '${q.unit}' is not a temperature unit (use degC, K or degF)`;
  return null;
}
