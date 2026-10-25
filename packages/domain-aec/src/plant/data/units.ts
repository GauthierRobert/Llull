/**
 * Units of the physical property types (plant 08 DAT §3, AF-04). A unit converts to the base unit of its family by `base = value * scale + offset`;
 * units of different families (gauge vs absolute pressure) never convert into each other: the atmosphere would be an assumption.
 * @invariant conversions are exact products of the factors below; temperature is affine
 */

import type { PropertyType } from './model';

interface UnitDef {
  readonly family: string;
  readonly scale: number;
  readonly offset?: number;
}

const unit = (family: string, scale: number, offset = 0): UnitDef => ({ family, scale, offset });

const UNITS: Readonly<Partial<Record<PropertyType, Readonly<Record<string, UnitDef>>>>> = {
  length: { mm: unit('length', 1), m: unit('length', 1000), cm: unit('length', 10), in: unit('length', 25.4), ft: unit('length', 304.8) },
  pressure: {
    barg: unit('gauge', 100),
    kPag: unit('gauge', 1),
    MPag: unit('gauge', 1000),
    psig: unit('gauge', 6.894757293168361),
    bara: unit('absolute', 100),
    kPaa: unit('absolute', 1),
    MPaa: unit('absolute', 1000),
    psia: unit('absolute', 6.894757293168361),
  },
  temperature: { degC: unit('temperature', 1, 273.15), K: unit('temperature', 1), degF: unit('temperature', 5 / 9, 273.15 - (32 * 5) / 9) },
  mass: { kg: unit('mass', 1), g: unit('mass', 0.001), t: unit('mass', 1000), lb: unit('mass', 0.45359237) },
  volumetricFlow: {
    'm3/h': unit('volumetricFlow', 1),
    'm3/s': unit('volumetricFlow', 3600),
    'l/s': unit('volumetricFlow', 3.6),
    'l/min': unit('volumetricFlow', 0.06),
  },
  massFlow: {
    'kg/h': unit('massFlow', 1),
    'kg/s': unit('massFlow', 3600),
    't/h': unit('massFlow', 1000),
    'lb/h': unit('massFlow', 0.45359237),
  },
};

/** The unit names a physical type accepts (empty for the other types). */
export function unitsOf(type: PropertyType): string[] {
  return Object.keys(UNITS[type] ?? {});
}

export const isKnownUnit = (type: PropertyType, name: string): boolean => UNITS[type]?.[name] !== undefined;

/** `value` of `from` expressed in `to`, or null when the two units are not convertible (unknown unit, gauge vs absolute). */
export function convertUnit(type: PropertyType, value: number, from: string, to: string): number | null {
  const source = UNITS[type]?.[from];
  const target = UNITS[type]?.[to];
  if (source === undefined || target === undefined || source.family !== target.family) return null;
  if (from === to) return value;
  const base = value * source.scale + (source.offset ?? 0);
  return (base - (target.offset ?? 0)) / target.scale;
}

/** Lowest value a physical property can take in `unit` (absolute zero for temperatures, 0 for mass / flows / lengths / absolute pressures), or null. */
export function lowestValue(type: PropertyType, unitName: string): number | null {
  if (type === 'temperature') return convertUnit(type, 0, 'K', unitName);
  if (type === 'mass' || type === 'massFlow' || type === 'volumetricFlow' || type === 'length') return 0;
  if (type === 'pressure' && UNITS.pressure?.[unitName]?.family === 'absolute') return 0;
  return null;
}
