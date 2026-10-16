/** Thermal quantity kinds, dimension-checked conversion to SI and to the 05 FEA unit systems (PHY-03 TR-THM-04, TECHNICAL_SPEC 5.3). */

import { convertValue, isUnitFailure, parseUnit } from '../../lib/quantity';

/** SI unit of every thermal quantity kind. */
const SI_UNITS = {
  length: 'm',
  conductivity: 'W/(m*K)',
  specificHeat: 'J/(kg*K)',
  density: 'kg/m^3',
  film: 'W/(m^2*K)',
  flux: 'W/m^2',
  generation: 'W/m^3',
  stefanBoltzmann: 'W/(m^2*K^4)',
  diffusivity: 'm^2/s',
  time: 's',
  latentHeat: 'J/kg',
  resistance: 'm^2*K/W',
  inverseLength: '1/m',
  temperature: 'K',
  temperatureDifference: 'K',
  ratio: '1',
} as const;

export type ThermalKind = keyof typeof SI_UNITS;

export const siUnitOf = (kind: ThermalKind): string => SI_UNITS[kind];

export type Converted = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string };

/**
 * Quantity -> SI number. Absolute temperatures convert affinely to K; a temperature difference must be in an interval unit (K), never degC / degF.
 */
export function toSi(kind: ThermalKind, quantity: { readonly value: number; readonly unit: string }): Converted {
  if (kind === 'temperatureDifference') {
    const parsed = parseUnit(quantity.unit);
    if (!isUnitFailure(parsed) && parsed.offset !== 0) {
      return { ok: false, reason: `'${quantity.unit}' is an absolute temperature scale; a temperature difference needs 'K'` };
    }
  }
  const converted = convertValue(quantity.value, quantity.unit, SI_UNITS[kind]);
  return isUnitFailure(converted)
    ? { ok: false, reason: `unit '${quantity.unit}' is not a ${kind} unit (${SI_UNITS[kind]}): ${converted.message}` }
    : { ok: true, value: converted.value };
}

/** Back from SI to `unit` of the same dimension. */
export function fromSi(kind: ThermalKind, value: number, unit: string): number {
  const converted = convertValue(value, SI_UNITS[kind], unit);
  return isUnitFailure(converted) ? Number.NaN : converted.value;
}

export const UNIT_SYSTEMS = ['N-m-kg-s', 'N-mm-t-s', 'lbf-in-slinch-s'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

const scaleOf = (from: string, to: string): number => {
  const converted = convertValue(1, from, to);
  return isUnitFailure(converted) ? Number.NaN : converted.value;
};

/** SI size of the system's mass, length and time units (a tonne, a millimetre, a slinch = lbf s^2 / in ...). */
function baseScales(system: UnitSystem): { readonly mass: number; readonly length: number; readonly time: number } {
  if (system === 'N-m-kg-s') return { mass: 1, length: 1, time: 1 };
  if (system === 'N-mm-t-s') return { mass: 1000, length: 1e-3, time: 1 };
  const inch = scaleOf('in', 'm');
  return { mass: scaleOf('lbf', 'N') / inch, length: inch, time: 1 };
}

/** Multiplier from SI to the system for a kind, from its dimension vector (M, L, T; temperature stays in K). */
function systemFactor(kind: ThermalKind, system: UnitSystem): number {
  const parsed = parseUnit(SI_UNITS[kind]);
  if (isUnitFailure(parsed)) return Number.NaN;
  const [mass = 0, length = 0, time = 0] = parsed.dimension;
  const scales = baseScales(system);
  return 1 / (scales.mass ** mass * scales.length ** length * scales.time ** time);
}

export const siToSystem = (kind: ThermalKind, value: number, system: UnitSystem): number => value * systemFactor(kind, system);

export const systemToSi = (kind: ThermalKind, value: number, system: UnitSystem): number => value / systemFactor(kind, system);
