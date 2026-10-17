/** Temperature and length conversions of the thermo-mechanical FE path (pure; affine maps are precomputed once per field). */

import type { Q, TemperatureScale } from '@core/model/analysis';
import { convertValue, isUnitFailure } from '@lib/quantity';

export interface Affine {
  readonly offset: number;
  readonly scale: number;
}

/** `value_to = offset + scale * value_from` between two units of the same dimension (temperature scales included), or null. */
export function affineBetween(from: string, to: string): Affine | null {
  const zero = convertValue(0, from, to);
  const one = convertValue(1, from, to);
  if (isUnitFailure(zero) || isUnitFailure(one)) return null;
  return { offset: zero.value, scale: one.value - zero.value };
}

/** `q` expressed in the temperature scale, or null (bad unit / dimension). */
export function temperatureIn(q: Q, scale: TemperatureScale): number | null {
  const converted = convertValue(q.value, q.unit, scale);
  return isUnitFailure(converted) ? null : converted.value;
}

/** Absolute temperature in K of a value in the scale. */
export const kelvinOf = (value: number, scale: TemperatureScale): number => (scale === 'K' ? value : value + 273.15);

/** Value in the scale of an absolute temperature in K. */
export const fromKelvin = (kelvin: number, scale: TemperatureScale): number => (scale === 'K' ? kelvin : kelvin - 273.15);

/** Metres in one `unit` of length, or null. */
export function metresPer(unit: string): number | null {
  const converted = convertValue(1, unit, 'm');
  return isUnitFailure(converted) ? null : converted.value;
}
