/** Pressure units of the fluids commands, converted to Pa. */

import { z } from '@core/commands/schema';

export const PRESSURE_UNITS = { Pa: 1, kPa: 1e3, MPa: 1e6, bar: 1e5, atm: 101325, psi: 6894.757293168361 } as const;

export type PressureUnit = keyof typeof PRESSURE_UNITS;

export const pressureUnitParam = z
  .enum(['Pa', 'kPa', 'MPa', 'bar', 'atm', 'psi'])
  .describe('Unit of every pressure parameter: Pa, kPa, MPa, bar, atm (101325 Pa) or psi (6894.757 Pa). Required.');

export const toPascal = (value: number, unit: PressureUnit): number => value * PRESSURE_UNITS[unit];
