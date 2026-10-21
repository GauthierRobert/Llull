/** Length arithmetic of the fastener plugin: integer ticks (1e-6 of a working unit) so grip rules never see float noise. */

import { round6 } from '@lib/compactNumber';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { fromMm, toMm } from '@core/model/units';
import type { CadDocument } from '@core/model/types';

const TICKS_PER_UNIT = 1_000_000;

/** `value` in `unit` expressed in `target`, or null when a unit does not parse or the dimensions differ. */
export function convertTo(value: number, unit: string, target: string): number | null {
  const converted = convertValue(value, unit, target);
  return isUnitFailure(converted) ? null : converted.value;
}

/** Integer ticks of `value` (given in `unit`) in the working unit `work`; null on a unit error. */
export function toTicks(value: number, unit: string, work: string): number | null {
  const converted = convertTo(value, unit, work);
  return converted === null ? null : Math.round(converted * TICKS_PER_UNIT);
}

/** Inches of `ticks` of the working unit `work`, rounded to 1e-6 in. */
export function ticksToInches(ticks: number, work: string): number {
  const inches = convertTo(ticks / TICKS_PER_UNIT, work, 'in') ?? ticks / TICKS_PER_UNIT;
  return round6(inches);
}

/** Length of `inches` in document units. */
export const inchesToDoc = (doc: Pick<CadDocument, 'units'>, inches: number): number => fromMm(doc, inches * 25.4);

/** Document-unit length in inches. */
export const docToInches = (doc: Pick<CadDocument, 'units'>, value: number): number => toMm(doc, value) / 25.4;

/** Length `value` in `unit` as document units; null on a unit error. */
export function quantityToDoc(doc: Pick<CadDocument, 'units'>, value: number, unit: string): number | null {
  const mm = convertTo(value, unit, 'mm');
  return mm === null ? null : fromMm(doc, mm);
}

/** Contact tolerance between stacked layers: 1e-4 in (TECHNICAL_SPEC §5.3). */
export const CONTACT_TOLERANCE_IN = 1e-4;
