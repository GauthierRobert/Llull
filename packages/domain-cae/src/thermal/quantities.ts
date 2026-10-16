/** Dimension-checked temperature / thermal quantities and the case temperature scale (PHY-03 FR-THM-19). */

import type { Q, TemperatureScale } from '@core/model/analysis';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { toSi, type ThermalKind } from '@lib/thermalUnits';

/** Absolute zero written to the deck (`*PHYSICAL CONSTANTS, ABSOLUTE ZERO=`): the scale's value of 0 K. */
export const absoluteZeroOf = (scale: TemperatureScale): number => (scale === 'degC' ? -273.15 : 0);

/** Problem text when `q` is not a finite quantity of `kind` (temperatures also > 0 K), else null. */
export function quantityProblem(kind: ThermalKind, q: Q): string | null {
  if (!Number.isFinite(q.value)) return 'the value must be a finite number';
  const si = toSi(kind, q);
  if (!si.ok) return si.reason;
  if (kind === 'temperature' && !(si.value > 0)) return `${q.value} ${q.unit} is at or below absolute zero`;
  return null;
}

/** Temperature `q` expressed on the case scale (affine); NaN when the unit is not a temperature. */
export function inScale(q: Q, scale: TemperatureScale): number {
  const converted = convertValue(q.value, q.unit, scale);
  return isUnitFailure(converted) ? Number.NaN : converted.value;
}

/** Value of `q` in SI (NaN when the unit does not fit `kind`). */
export function siOf(kind: ThermalKind, q: Q): number {
  const si = toSi(kind, q);
  return si.ok ? si.value : Number.NaN;
}
