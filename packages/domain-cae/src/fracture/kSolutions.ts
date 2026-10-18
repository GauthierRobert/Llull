/** Stress-intensity geometry factors (PHY-08 TR-FRC-10/11): K = beta * sigma * sqrt(pi a), SI lengths [m], stresses [MPa], K [MPa sqrt(m)]. */

import type { CrackGeometry } from '@core/model/durability';
import { convertValue, isUnitFailure } from '@lib/quantity';

/** A crack in SI lengths with its K solution. */
export type SolvedGeometry =
  | { readonly kind: 'center_through'; readonly a: number; readonly W: number; readonly t: number }
  | { readonly kind: 'edge_through'; readonly a: number; readonly b: number; readonly t: number; readonly form: 'tada' | 'polynomial' }
  | { readonly kind: 'surface_semi_elliptical'; readonly a: number; readonly c: number; readonly t: number; readonly b: number };

const meters = (quantity: { readonly value: number; readonly unit: string }): number | null => {
  const converted = convertValue(quantity.value, quantity.unit, 'm');
  return isUnitFailure(converted) ? null : converted.value;
};

/** `geometry` with every length in metres, or a problem text (unit not a length, non-positive, a >= bound, a/c > 1). */
export function solvedGeometry(geometry: CrackGeometry): SolvedGeometry | string {
  const lengths = (names: readonly string[]): number[] | string => {
    const record = geometry as unknown as Record<string, { value: number; unit: string }>;
    const values: number[] = [];
    for (const name of names) {
      const quantity = record[name];
      const value = quantity === undefined ? null : meters(quantity);
      if (value === null || !Number.isFinite(value) || !(value > 0))
        return `${name} must be a length > 0 (got ${JSON.stringify(quantity)})`;
      values.push(value);
    }
    return values;
  };
  if (geometry.kind === 'center_through') {
    const found = lengths(['a', 'W', 't']);
    if (typeof found === 'string') return found;
    const [a = 0, W = 0, t = 0] = found;
    return a < W / 2 ? { kind: 'center_through', a, W, t } : 'a (half-length) must be < W/2';
  }
  if (geometry.kind === 'edge_through') {
    const found = lengths(['a', 'b', 't']);
    if (typeof found === 'string') return found;
    const [a = 0, b = 0, t = 0] = found;
    return a < b ? { kind: 'edge_through', a, b, t, form: geometry.form } : 'a must be < b';
  }
  const found = lengths(['a', 'c', 't', 'b']);
  if (typeof found === 'string') return found;
  const [a = 0, c = 0, t = 0, b = 0] = found;
  if (!(a < t)) return 'a must be < t (part-through crack)';
  if (a > c) return 'a/c > 1 is not supported (a/c <= 1 only)';
  return { kind: 'surface_semi_elliptical', a, c, t, b };
}

export interface Validity {
  readonly inRange: boolean;
  readonly limits: string;
  readonly accuracy: string;
  readonly source: string;
}

const secantBeta = (a: number, W: number): number => Math.sqrt(1 / Math.cos((Math.PI * a) / W));

function tadaBeta(a: number, b: number): number {
  const x = (Math.PI * a) / (2 * b);
  return (Math.sqrt(((2 * b) / (Math.PI * a)) * Math.tan(x)) * (0.752 + 2.02 * (a / b) + 0.37 * (1 - Math.sin(x)) ** 3)) / Math.cos(x);
}

function polynomialBeta(a: number, b: number): number {
  const r = a / b;
  return 1.122 - 0.231 * r + 10.55 * r ** 2 - 21.71 * r ** 3 + 30.382 * r ** 4;
}

/** Newman-Raju shape factor Q (a/c <= 1). */
export const newmanRajuQ = (aOverC: number): number => 1 + 1.464 * aOverC ** 1.65;

/** Newman-Raju F at angle phi [rad] (grade C: transcription unconfirmed, OQ-FRC-01). */
export function newmanRajuF(aOverC: number, aOverT: number, cOverB: number, phi: number): number {
  const m1 = 1.13 - 0.09 * aOverC;
  const m2 = -0.54 + 0.89 / (0.2 + aOverC);
  const m3 = 0.5 - 1 / (0.65 + aOverC) + 14 * (1 - aOverC) ** 24;
  const g = 1 + (0.1 + 0.35 * aOverT ** 2) * (1 - Math.sin(phi)) ** 2;
  const fPhi = (aOverC ** 2 * Math.cos(phi) ** 2 + Math.sin(phi) ** 2) ** 0.25;
  const fW = Math.sqrt(1 / Math.cos(((Math.PI * cOverB) / 2) * Math.sqrt(aOverT)));
  return (m1 + m2 * aOverT ** 2 + m3 * aOverT ** 4) * g * fPhi * fW;
}

/** Validity of the solution for `geometry` at its current size. */
export function validityOf(geometry: SolvedGeometry): Validity {
  if (geometry.kind === 'center_through') {
    const ratio = geometry.a / geometry.W;
    return {
      inRange: ratio <= 0.4,
      limits: 'a/W <= 0.4 (a = half-length, W = full width)',
      accuracy: 'secant (Feddersen) form, a few percent',
      source: 'K = sigma sqrt(pi a) sqrt(sec(pi a / W))',
    };
  }
  if (geometry.kind === 'edge_through') {
    const ratio = geometry.a / geometry.b;
    const poly = geometry.form === 'polynomial';
    return {
      inRange: ratio <= (poly ? 0.6 : 0.9),
      limits: poly ? 'a/b <= 0.6 (polynomial)' : 'a/b <= 0.9 (Tada)',
      accuracy: '0.5 % within the limit',
      source: 'single-edge crack in tension, long plate (Tada / Paris / Irwin)',
    };
  }
  return {
    inRange: geometry.a / geometry.t <= 0.8 && geometry.a / geometry.c <= 1,
    limits: 'a/c <= 1, a/t <= 0.8',
    accuracy: 'Newman-Raju 1981; transcription unconfirmed (grade C), indicative only',
    source: 'Newman & Raju, surface crack in tension',
  };
}

/** beta of K = beta sigma sqrt(pi a) (surface crack: at the deepest point, phi 90 deg, unless `phi` is given). */
export function betaOf(geometry: SolvedGeometry, phi = Math.PI / 2): number {
  if (geometry.kind === 'center_through') return secantBeta(geometry.a, geometry.W);
  if (geometry.kind === 'edge_through')
    return geometry.form === 'tada' ? tadaBeta(geometry.a, geometry.b) : polynomialBeta(geometry.a, geometry.b);
  const aOverC = geometry.a / geometry.c;
  return newmanRajuF(aOverC, geometry.a / geometry.t, geometry.c / geometry.b, phi) / Math.sqrt(newmanRajuQ(aOverC));
}

/** The same geometry with crack size `a` [m]. */
export function withSize(geometry: SolvedGeometry, a: number): SolvedGeometry {
  return { ...geometry, a };
}

/** Largest crack size [m] the K solution covers (net section / validity bound). */
export function sizeLimit(geometry: SolvedGeometry): number {
  if (geometry.kind === 'center_through') return 0.4 * geometry.W;
  if (geometry.kind === 'edge_through') return (geometry.form === 'polynomial' ? 0.6 : 0.9) * geometry.b;
  return Math.min(0.8 * geometry.t, geometry.c);
}

/** Net-section yield size [m] at stress `sigma` for yield strength `fty` (both MPa): sigma W / (W - 2a) = Fty (centre), sigma b / (b - a) (edge). */
export function netYieldSize(geometry: SolvedGeometry, sigma: number, fty: number): number | null {
  if (geometry.kind === 'center_through') return (geometry.W / 2) * (1 - sigma / fty);
  if (geometry.kind === 'edge_through') return geometry.b * (1 - sigma / fty);
  return null;
}

/** Gross stress [MPa] at which the net section yields at size `a`: Fty (1 - 2a/W) (centre), Fty (1 - a/b) (edge); null for a surface crack. */
export function netYieldStress(geometry: SolvedGeometry, a: number, fty: number): number | null {
  if (geometry.kind === 'center_through') return fty * (1 - (2 * a) / geometry.W);
  if (geometry.kind === 'edge_through') return fty * (1 - a / geometry.b);
  return null;
}

/** K [MPa sqrt(m)] at crack size `a` for gross stress `sigma` [MPa]. */
export const stressIntensityAt = (geometry: SolvedGeometry, a: number, sigma: number): number =>
  betaOf(withSize(geometry, a)) * sigma * Math.sqrt(Math.PI * a);
