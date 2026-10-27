/**
 * Nominal sizes (TR-PSC-01): NPS designations compared as exact rationals, the fixed DN <-> NPS pairing (ISO 6708 / ASME B36.10M) and the
 * EN 10220 outside diameters per DN. Numeric NPS input is accepted in eighths (`2.5` -> `"2-1/2"`); anything else is refused.
 */

import type { NominalSize } from './types';

interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const reduce = (numerator: number, denominator: number): Rational => {
  const divisor = gcd(numerator, denominator) || 1;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
};

/** Parses `"2-1/2"`, `"2 1/2"`, `"1/2"`, `"24"`; null when it is not a positive rational of safe integers (the gcd never sees Infinity or NaN). */
function parseRational(text: string): Rational | null {
  const match = /^\s*(?:(\d+)(?:[-\s]+(\d+)\/(\d+))?|(\d+)\/(\d+))\s*$/.exec(text);
  if (match === null) return null;
  const [, whole, fractionN, fractionD, onlyN, onlyD] = match;
  const denominator = Number(fractionD ?? onlyD ?? 1);
  if (denominator === 0) return null;
  const numerator = Number(whole ?? 0) * denominator + Number(fractionN ?? onlyN ?? 0);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null;
  return numerator > 0 ? reduce(numerator, denominator) : null;
}

const keyOf = ({ numerator, denominator }: Rational): string => {
  const whole = Math.floor(numerator / denominator);
  const rest = numerator - whole * denominator;
  if (rest === 0) return String(whole);
  return whole === 0 ? `${rest}/${denominator}` : `${whole}-${rest}/${denominator}`;
};

/** NPS designation of a string (`"2-1/2"`) or number (`2.5`, multiples of 1/8 only); null when it is not a size. */
export function parseNps(input: string | number): NominalSize | null {
  let rational: Rational | null;
  if (typeof input === 'number') {
    const eighths = input * 8;
    rational =
      Number.isFinite(input) && input > 0 && Math.abs(eighths - Math.round(eighths)) < 1e-9 ? reduce(Math.round(eighths), 8) : null;
  } else rational = parseRational(input);
  return rational === null ? null : { system: 'NPS', key: keyOf(rational), value: rational.numerator / rational.denominator };
}

/** DN designation of an integer (or integer string); null otherwise. */
export function parseDn(input: string | number): NominalSize | null {
  const value = typeof input === 'number' ? input : /^\s*\d+\s*$/.test(input) ? Number(input) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? { system: 'DN', key: String(value), value } : null;
}

/** NPS keys below 4 and their DN; from NPS 4 up DN = 25 x NPS. */
const SMALL_NPS_DN: ReadonlyArray<readonly [string, number]> = [
  ['1/8', 6],
  ['1/4', 8],
  ['3/8', 10],
  ['1/2', 15],
  ['3/4', 20],
  ['1', 25],
  ['1-1/4', 32],
  ['1-1/2', 40],
  ['2', 50],
  ['2-1/2', 65],
  ['3', 80],
  ['3-1/2', 90],
];

const SMALL_DN_TO_NPS: ReadonlyMap<number, string> = new Map(SMALL_NPS_DN.map(([nps, dn]) => [dn, nps]));
const SMALL_NPS_TO_DN: ReadonlyMap<string, number> = new Map(SMALL_NPS_DN);

/** DN of an NPS size, or null when the pairing is not defined (non-integer NPS above 3-1/2). */
export function npsToDn(nps: NominalSize): NominalSize | null {
  const small = SMALL_NPS_TO_DN.get(nps.key);
  if (small !== undefined) return parseDn(small);
  return Number.isInteger(nps.value) && nps.value >= 4 ? parseDn(nps.value * 25) : null;
}

/** NPS of a DN size, or null when the pairing is not defined. */
export function dnToNps(dn: NominalSize): NominalSize | null {
  const small = SMALL_DN_TO_NPS.get(dn.value);
  if (small !== undefined) return parseNps(small);
  return dn.value >= 100 && dn.value % 25 === 0 ? parseNps(dn.value / 25) : null;
}

/** EN 10220 outside diameter (mm) per DN: grade A for DN15..125 (two sources), B above (pack component_references.json, S25 to S27). */
const EN_10220_OD_MM: ReadonlyMap<number, number> = new Map([
  [15, 21.3],
  [20, 26.9],
  [25, 33.7],
  [32, 42.4],
  [40, 48.3],
  [50, 60.3],
  [65, 76.1],
  [80, 88.9],
  [100, 114.3],
  [125, 139.7],
  [150, 168.3],
  [200, 219.1],
  [250, 273],
  [300, 323.9],
  [350, 355.6],
  [400, 406.4],
  [450, 457],
  [500, 508],
  [600, 610],
]);

/** EN 10220 outside diameter of `dn` in mm, or null when the series has no such DN. */
export const en10220OutsideDiameter = (dn: NominalSize): number | null => EN_10220_OD_MM.get(dn.value) ?? null;

/** Both designations of a size given as NPS or DN (`nps` / `dn` null where the pairing is undefined); null when the input is not a size. */
export function sizePair(input: {
  readonly nps?: string | number | undefined;
  readonly dn?: string | number | undefined;
}): { readonly nps: NominalSize | null; readonly dn: NominalSize | null } | null {
  if (input.nps !== undefined) {
    const nps = parseNps(input.nps);
    return nps === null ? null : { nps, dn: npsToDn(nps) };
  }
  if (input.dn !== undefined) {
    const dn = parseDn(input.dn);
    return dn === null ? null : { nps: dnToNps(dn), dn };
  }
  return null;
}

/** DN values of the EN 10220 series, ascending. */
export const en10220Dns = (): readonly number[] => [...EN_10220_OD_MM.keys()];
