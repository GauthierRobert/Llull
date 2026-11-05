/**
 * Bolt resistances by property class and exact ISO metric size (EN 1993-1-8 Tab. 3.4, shear in the threaded part, no packing, not
 * countersunk). Source grade B for the class factors (secondary extracts, standard text not read); stress areas ISO 898-1 coarse thread.
 */

const GAMMA_M2 = 1.25;
const K2 = 0.9;

export type BoltClass = '4.6' | '5.6' | '6.8' | '8.8' | '10.9';

export const DEFAULT_BOLT_CLASS: BoltClass = '8.8';

interface ClassRow {
  /** Ultimate strength fub, N/mm². */
  readonly fub: number;
  /** Yield strength fyb, N/mm². */
  readonly fyb: number;
  /** Shear factor αv for shear in the threaded part. */
  readonly alphaV: number;
}

const CLASSES: Readonly<Record<BoltClass, ClassRow>> = {
  '4.6': { fub: 400, fyb: 240, alphaV: 0.6 },
  '5.6': { fub: 500, fyb: 300, alphaV: 0.6 },
  '6.8': { fub: 600, fyb: 480, alphaV: 0.5 },
  '8.8': { fub: 800, fyb: 640, alphaV: 0.6 },
  '10.9': { fub: 1000, fyb: 900, alphaV: 0.5 },
};

/** Tensile stress areas of ISO metric coarse-thread bolts, mm² (ISO 898-1), by nominal diameter. */
const STRESS_AREA: Readonly<Record<number, number>> = {
  12: 84.3,
  14: 115,
  16: 157,
  18: 192,
  20: 245,
  22: 303,
  24: 353,
  27: 459,
  30: 561,
  36: 817,
};

const SIZES = Object.keys(STRESS_AREA).map(Number);
const SIZE_TOLERANCE = 1e-6;

export interface BoltRefusal {
  readonly code: 'STL_BOLT_CLASS_UNKNOWN' | 'STL_BOLT_SIZE_NONSTANDARD';
  readonly message: string;
}

export const isBoltRefusal = <T extends object>(value: T | BoltRefusal): value is BoltRefusal => 'code' in value;

const classRow = (propertyClass: string): ClassRow | undefined =>
  Object.prototype.hasOwnProperty.call(CLASSES, propertyClass) ? CLASSES[propertyClass as BoltClass] : undefined;

const unknownClass = (propertyClass: string): BoltRefusal => ({
  code: 'STL_BOLT_CLASS_UNKNOWN',
  message: `STL_BOLT_CLASS_UNKNOWN: bolt property class '${propertyClass}' is not supported (accepted: ${Object.keys(CLASSES).join(', ')})`,
});

/** Stress area of an exact table size, or the refusal naming the neighbouring sizes. */
function stressArea(diameterMm: number): number | BoltRefusal {
  const exact = SIZES.find((size) => Math.abs(size - diameterMm) < SIZE_TOLERANCE);
  if (exact !== undefined) return STRESS_AREA[exact] as number;
  const below = SIZES.filter((size) => size < diameterMm).pop();
  const above = SIZES.find((size) => size > diameterMm);
  const neighbours = [below, above].filter((size): size is number => size !== undefined).map((size) => `M${size}`);
  return {
    code: 'STL_BOLT_SIZE_NONSTANDARD',
    message: `STL_BOLT_SIZE_NONSTANDARD: bolt diameter ${diameterMm} mm is not an ISO metric coarse size of the stress-area table (neighbours: ${neighbours.join(', ') || 'none'}; sizes M${SIZES.join(', M')})`,
  };
}

/**
 * Design resistances of one bolt, N: tension k2 fub As / γM2, shear αv fub As / γM2.
 * @failure STL_BOLT_CLASS_UNKNOWN — class not 4.6 / 5.6 / 6.8 / 8.8 / 10.9
 * @failure STL_BOLT_SIZE_NONSTANDARD — diameter not an exact table size (M12..M36)
 */
export function boltResistance(
  diameterMm: number,
  propertyClass: string = DEFAULT_BOLT_CLASS,
): { tension: number; shear: number } | BoltRefusal {
  const row = classRow(propertyClass);
  if (!row) return unknownClass(propertyClass);
  const area = stressArea(diameterMm);
  if (typeof area !== 'number') return area;
  return { tension: (K2 * row.fub * area) / GAMMA_M2, shear: (row.alphaV * row.fub * area) / GAMMA_M2 };
}

/**
 * Design resistances of one anchor bolt, N: tension k2 fub As / γM2; shear (threads in the shear plane, EN 1993-1-8 §6.2.2(7)) αbc fub As
 * / γM2 with αbc = 0.44 − 0.0003 fyb.
 * @failure STL_BOLT_CLASS_UNKNOWN | STL_BOLT_SIZE_NONSTANDARD — as boltResistance
 */
export function anchorBoltResistance(
  diameterMm: number,
  propertyClass: string = DEFAULT_BOLT_CLASS,
): { tension: number; shear: number } | BoltRefusal {
  const row = classRow(propertyClass);
  if (!row) return unknownClass(propertyClass);
  const area = stressArea(diameterMm);
  if (typeof area !== 'number') return area;
  return { tension: (K2 * row.fub * area) / GAMMA_M2, shear: ((0.44 - 0.0003 * row.fyb) * row.fub * area) / GAMMA_M2 };
}

/** The class a command checks with: the caller's, else the default (reported as defaulted by the command). */
export const resolveBoltClass = (input: string | undefined): { boltClass: string; defaulted: boolean } =>
  input === undefined ? { boltClass: DEFAULT_BOLT_CLASS, defaulted: true } : { boltClass: input.trim(), defaulted: false };

/** Refusal of a class name, or null when it is supported (commands validate it once before a long check). */
export const boltClassProblem = (propertyClass: string): BoltRefusal | null =>
  classRow(propertyClass) ? null : unknownClass(propertyClass);
