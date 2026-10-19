/** Pure fatigue life mathematics: Basquin / power-law / table S-N, mean-stress equivalents, Coffin-Manson-Basquin (Newton), Neuber (TR-FAT-10..13). */

import type { FatigueMaterialModel } from '@core/model/materialDurability';
import { convertValue, isUnitFailure } from '@lib/quantity';
import type { Quantity } from '@core/model/quantity';

/** `quantity` in MPa, or null when its unit is not a stress. */
export function toMpa(quantity: Quantity): number | null {
  const converted = convertValue(quantity.value, quantity.unit, 'MPa');
  return isUnitFailure(converted) ? null : converted.value;
}

export interface CurveLife {
  /** Cycles to failure (Infinity below an endurance limit / cut-off). */
  readonly cycles: number;
  readonly extrapolated: boolean;
}

type StressLifeModel = Extract<FatigueMaterialModel, { kind: 'sn_basquin' | 'sn_power_law' | 'sn_table' }>;

const outsideRange = (cycles: number, range: { readonly minCycles: number; readonly maxCycles: number } | undefined): boolean =>
  range !== undefined && (cycles > range.maxCycles || cycles < range.minCycles);

function tableLife(model: Extract<StressLifeModel, { kind: 'sn_table' }>, amplitude: number): CurveLife | null {
  const family = model.families[0];
  if (family === undefined || family.points.length < 2) return null;
  const points = [...family.points].sort((a, b) => b[1] - a[1]);
  const log = (value: number): number => Math.log10(value);
  const x = log(amplitude);
  let segment = points.length - 2;
  for (let i = 0; i + 1 < points.length; i += 1) {
    if (amplitude <= (points[i]?.[1] ?? 0) && amplitude >= (points[i + 1]?.[1] ?? 0)) {
      segment = i;
      break;
    }
  }
  const [n0 = 1, s0 = 1] = points[segment] ?? [];
  const [n1 = 1, s1 = 1] = points[segment + 1] ?? [];
  const slope = (log(n1) - log(n0)) / (log(s1) - log(s0));
  const cycles = 10 ** (log(n0) + slope * (x - log(s0)));
  const inside = amplitude <= (points[0]?.[1] ?? 0) && amplitude >= (points.at(-1)?.[1] ?? 0);
  return { cycles, extrapolated: !inside };
}

/**
 * Cycles to failure at a fully reversed equivalent amplitude (MPa) on an S-N curve.
 * @failure amplitude <= 0 -> Infinity; a malformed table -> null
 */
export function stressLife(model: StressLifeModel, amplitudeMpa: number): CurveLife | null {
  if (!(amplitudeMpa > 0)) return { cycles: Number.POSITIVE_INFINITY, extrapolated: false };
  if (model.kind === 'sn_basquin') {
    const sigmaF = toMpa(model.sigmaF);
    if (sigmaF === null || !(sigmaF > 0) || !(model.b < 0)) return null;
    const endurance = model.enduranceAmplitude === undefined ? null : toMpa(model.enduranceAmplitude);
    if (endurance !== null && amplitudeMpa <= endurance) return { cycles: Number.POSITIVE_INFINITY, extrapolated: false };
    // exp(ln x · k) rather than x ** k: ~3x cheaper per cycle, and the native twin (llull-jsmath exp / log) stays bit-identical.
    const cycles = Math.exp(Math.log(amplitudeMpa / sigmaF) * (1 / model.b)) / 2;
    return { cycles, extrapolated: outsideRange(cycles, model.conditions.testedLifeRange) };
  }
  if (model.kind === 'sn_power_law') {
    const sD = toMpa(model.sD);
    if (sD === null || !(sD > 0)) return null;
    let exponent = model.k;
    if (amplitudeMpa < sD && model.k2 === 'cutoff') return { cycles: Number.POSITIVE_INFINITY, extrapolated: false };
    if (amplitudeMpa < sD && typeof model.k2 === 'number') exponent = model.k2;
    const cycles = model.nD * Math.exp(Math.log(amplitudeMpa / sD) * -exponent);
    return { cycles, extrapolated: outsideRange(cycles, model.conditions.testedLifeRange) };
  }
  return tableLife(model, amplitudeMpa);
}

export type MeanModelName = 'none' | 'goodman' | 'gerber' | 'soderberg' | 'morrow' | 'swt' | 'walker';

export interface MeanStressInputs {
  readonly model: MeanModelName;
  /** Walker exponent gamma (model `walker`). */
  readonly gamma?: number;
  readonly su?: number;
  readonly sy?: number;
  readonly sigmaF?: number;
  readonly compressiveMean: 'no_benefit' | 'formula';
}

/**
 * Equivalent fully reversed amplitude sigma_ar of (sa, sm) in MPa.
 * @invariant sm < 0 with `no_benefit` leaves sa unchanged for Goodman / Gerber / Soderberg / Morrow; SWT / Walker with smax <= 0 give 0;
 *   a mean at or beyond the strength of its model gives Infinity (static failure); null = a strength the model needs is missing
 */
export function equivalentAmplitude(sa: number, sm: number, inputs: MeanStressInputs): number | null {
  const { model } = inputs;
  if (model === 'none') return sa;
  const smax = sm + sa;
  if (model === 'swt' || model === 'walker') {
    if (smax <= 0) return 0;
    const gamma = model === 'swt' ? 0.5 : (inputs.gamma ?? Number.NaN);
    return Number.isFinite(gamma) ? smax ** (1 - gamma) * sa ** gamma : null;
  }
  const strength = model === 'soderberg' ? inputs.sy : model === 'morrow' ? inputs.sigmaF : inputs.su;
  if (strength === undefined || !(strength > 0)) return null;
  if (sm < 0 && inputs.compressiveMean === 'no_benefit') return sa;
  const ratio = model === 'gerber' ? (sm / strength) ** 2 : sm / strength;
  return ratio >= 1 ? Number.POSITIVE_INFINITY : sa / (1 - ratio);
}

/** One term `coefficient * (2N)^exponent` of a strain-life equation. */
interface Term {
  readonly coefficient: number;
  readonly exponent: number;
}

/** Reversals 2N with sum(term) = target, Newton on x = log10(2N) from x0 = 3 with a bisection fallback; null when not found. */
function solveReversals(terms: readonly Term[], target: number): number | null {
  const value = (x: number): number => terms.reduce((sum, term) => sum + term.coefficient * 10 ** (x * term.exponent), 0) - target;
  const slope = (x: number): number =>
    Math.LN10 * terms.reduce((sum, term) => sum + term.coefficient * term.exponent * 10 ** (x * term.exponent), 0);
  let x = 3;
  for (let i = 0; i < 200; i += 1) {
    const step = value(x) / slope(x);
    if (!Number.isFinite(step)) break;
    x -= step;
    if (Math.abs(step) < 1e-14) return Math.abs(value(x)) <= 1e-12 * Math.max(target, 1e-300) ? 10 ** x : null;
  }
  let [low, high] = [-3, 14];
  if (value(low) * value(high) > 0) return null;
  for (let i = 0; i < 300; i += 1) {
    const mid = (low + high) / 2;
    if (value(mid) * value(low) > 0) low = mid;
    else high = mid;
  }
  return 10 ** ((low + high) / 2);
}

type StrainLifeModel = Extract<FatigueMaterialModel, { kind: 'en_coffin_manson' }>;

interface StrainConstants {
  readonly sigmaF: number;
  readonly E: number;
}

function constantsOf(model: StrainLifeModel): StrainConstants | null {
  const sigmaF = toMpa(model.sigmaF);
  const E = toMpa(model.E);
  return sigmaF === null || E === null || !(sigmaF > 0) || !(E > 0) ? null : { sigmaF, E };
}

/** Reversals to failure 2N at strain amplitude `epsA`: Coffin-Manson-Basquin with the Morrow mean-stress term (`sigmaM`, MPa) when given. */
export function strainLifeReversals(model: StrainLifeModel, epsA: number, sigmaM = 0): number | null {
  const k = constantsOf(model);
  if (k === null) return null;
  return solveReversals(
    [
      { coefficient: (k.sigmaF - sigmaM) / k.E, exponent: model.b },
      { coefficient: model.epsF, exponent: model.c },
    ],
    epsA,
  );
}

/** Reversals to failure with the Smith-Watson-Topper parameter sigmaMax * epsA. */
export function swtLifeReversals(model: StrainLifeModel, sigmaMax: number, epsA: number): number | null {
  const k = constantsOf(model);
  if (k === null) return null;
  return solveReversals(
    [
      { coefficient: k.sigmaF ** 2 / k.E, exponent: 2 * model.b },
      { coefficient: k.sigmaF * model.epsF, exponent: model.b + model.c },
    ],
    sigmaMax * epsA,
  );
}

/** Transition reversals 2Nt where the elastic and plastic strain amplitudes are equal. */
export function transitionReversals(model: StrainLifeModel): number | null {
  const k = constantsOf(model);
  return k === null || model.b === model.c ? null : ((model.epsF * k.E) / k.sigmaF) ** (1 / (model.b - model.c));
}

export const notchFactor = (kt: number, q: number): number => 1 + q * (kt - 1);

type CyclicModel = Extract<FatigueMaterialModel, { kind: 'cyclic_ramberg_osgood' }>;

export interface CyclicCurve {
  readonly E: number;
  readonly kPrime: number;
  readonly nPrime: number;
}

export function cyclicCurveOf(model: CyclicModel): CyclicCurve | null {
  const E = toMpa(model.E);
  const kPrime = toMpa(model.Kprime);
  return E === null || kPrime === null || !(E > 0) || !(kPrime > 0) || !(model.nPrime > 0) ? null : { E, kPrime, nPrime: model.nPrime };
}

/** Total strain on the cyclic Ramberg-Osgood curve at stress `sigma`. */
export const cyclicStrain = (curve: CyclicCurve, sigma: number): number => sigma / curve.E + (sigma / curve.kPrime) ** (1 / curve.nPrime);

/** Local stress of Neuber's rule sigma * eps(sigma) = (Kf S)^2 / E for the elastic notch stress `elasticLocal` = Kf S (bisection, 1e-12 relative). */
export function neuberStress(curve: CyclicCurve, elasticLocal: number): number {
  if (!(elasticLocal > 0)) return 0;
  const target = elasticLocal ** 2 / curve.E;
  let [low, high] = [0, elasticLocal];
  for (let i = 0; i < 200 && high - low > 1e-13 * elasticLocal; i += 1) {
    const mid = (low + high) / 2;
    if (mid * cyclicStrain(curve, mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Masing hysteresis strain range for a stress range. */
export const masingStrainRange = (curve: CyclicCurve, stressRange: number): number =>
  stressRange / curve.E + 2 * (stressRange / (2 * curve.kPrime)) ** (1 / curve.nPrime);
