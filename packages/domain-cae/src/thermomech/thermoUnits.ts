/** Unit-bearing scalars of the thermo-mechanical commands: conversion to the canonical unit with dimension checks (lib/quantity). */

import { convertValue, isUnitFailure, type UnitFailure } from '@lib/quantity';

export interface Quantity {
  readonly value: number;
  readonly unit: string;
}

export type NumberOrFailure = number | UnitFailure;

export const failed = (value: NumberOrFailure): value is UnitFailure => typeof value !== 'number';

/** `value unit` expressed in `unit`; a dimension or grammar error is returned, never thrown. */
export function convertTo(quantity: Quantity, unit: string): NumberOrFailure {
  const converted = convertValue(quantity.value, quantity.unit, unit);
  return isUnitFailure(converted) ? converted : converted.value;
}

/** Absolute temperature in K (degC / degF offsets applied). */
export const toKelvin = (quantity: Quantity): NumberOrFailure => convertTo(quantity, 'K');

/** Temperature DIFFERENCE in K: the scale of the unit only (a difference of 65 degC is 65 K, not 338.15 K). */
export function differenceToKelvin(quantity: Quantity): NumberOrFailure {
  const one = convertValue(1, quantity.unit, 'K');
  const zero = convertValue(0, quantity.unit, 'K');
  if (isUnitFailure(one)) return one;
  if (isUnitFailure(zero)) return zero;
  return quantity.value * (one.value - zero.value);
}
