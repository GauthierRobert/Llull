/** Validation of `{ value, unit }` quantities used by the analysis set-up. */

import type { Q } from '@core/model/analysis';
import { convertValue, isUnitFailure, parseUnit, sameDimension, type Dimension } from '@lib/quantity';

const TEMPERATURE: Dimension = [0, 0, 0, 1, 0, 0, 0];

/** Named guard: the highest absolute temperature (K) any analysis input may state; above it a value is a mistake or an attack. */
export const MAX_PLAUSIBLE_TEMPERATURE = { value: 1e5, unit: 'K', source: 'llull guard' } as const;

/** Problem text when `q` is not a finite absolute temperature in [0, MAX_PLAUSIBLE_TEMPERATURE] K with a known temperature unit, else null. */
export function temperatureProblem(q: Q): string | null {
  if (!Number.isFinite(q.value)) return 'the temperature value must be a finite number';
  const parsed = parseUnit(q.unit);
  if (isUnitFailure(parsed)) return `unit '${q.unit}': ${parsed.message}`;
  if (!sameDimension(parsed.dimension, TEMPERATURE)) return `unit '${q.unit}' is not a temperature unit (use degC, K or degF)`;
  const kelvin = convertValue(q.value, q.unit, 'K');
  if (isUnitFailure(kelvin)) return `unit '${q.unit}': ${kelvin.message}`;
  if (kelvin.value < 0) return `${q.value} ${q.unit} is below absolute zero`;
  if (kelvin.value > MAX_PLAUSIBLE_TEMPERATURE.value)
    return `${q.value} ${q.unit} exceeds the plausible ceiling ${MAX_PLAUSIBLE_TEMPERATURE.value} ${MAX_PLAUSIBLE_TEMPERATURE.unit} (${MAX_PLAUSIBLE_TEMPERATURE.source})`;
  return null;
}
