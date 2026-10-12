import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { isPositiveNumber } from '@lib/isFiniteNumber';

/** m/s²; converts kg to kN (÷ 1000) and tonnes to N (× 1000 × GRAVITY). */
export const GRAVITY = 9.80665;

/** Weight in kN/m of a mass per metre in kg/m. */
export const weightKnPerMetre = (massKgPerMetre: number): number =>
  (massKgPerMetre * GRAVITY) / 1000;

/** Rounds to `digits` decimals; never returns -0. */
export const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits + 0;

/** Millimetres to metres, rounded to 2 decimals. */
export const roundedMetres = (millimetres: number): number => round(millimetres / 1000, 2);

/** Converter from document-unit lengths to millimetres (via metres). */
export const unitsToMm =
  (doc: Pick<CadDocument, 'units'>) =>
  (value: number): number =>
    toMetres(doc, value) * 1000;

/** Name of the first entry that is given but not a finite number > 0, or undefined when all are valid. */
export function firstNonPositive(
  entries: ReadonlyArray<readonly [name: string, value: number | undefined]>,
): string | undefined {
  return entries.find(([, value]) => value !== undefined && !isPositiveNumber(value))?.[0];
}
