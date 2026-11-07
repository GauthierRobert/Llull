/**
 * Fitting drive parameters to measured series (PHY-23 TR-DRV-25). Every model here is linear in its unknowns, so the fit is one linear least squares
 * (Householder QR, column-equilibrated condition estimate) and the covariance is sigma^2 (X^T X)^-1.
 * Mechanical (spin-down / spin-up): J w' = tau - T_f sign(w) - b w, w' by a centred difference on the measured speed.
 * Electrical (step response): u = R i + L di/dt + ke w with ke = kt (SI), L only when known.
 */

import { invertDense } from '@lib/denseLinalg';
import { solveLeastSquares } from '@lib/leastSquares';
import { elementAt } from '@lib/elementAt';

export const MECHANICAL = ['inertia', 'coulombNm', 'viscousNmsPerRad'] as const;
export const ELECTRICAL = ['resistance', 'torqueConstant'] as const;
export type Unknown = (typeof MECHANICAL)[number] | (typeof ELECTRICAL)[number];

/** Condition number of the equilibrated regressor above which the data cannot separate the unknowns (TR-DRV-25). */
export const MAX_CONDITION = 1e8;
/** A sample counts as moving when |w| exceeds this fraction of the largest |w| (the derivative must not straddle the stop). */
const MOVING_FRACTION = 1e-6;

export interface Channels {
  readonly t: readonly number[];
  readonly omega: readonly number[];
  readonly current?: readonly number[];
  readonly voltage?: readonly number[];
  readonly torque?: readonly number[];
}

interface FitValue {
  readonly value: number;
  /** 1 sigma from the residual covariance; null when the data has no spare equation (n = p). */
  readonly sigma: number | null;
}

export type FitResult =
  | {
      readonly ok: true;
      readonly values: Readonly<Record<string, FitValue>>;
      readonly residualRms: number;
      readonly samplesUsed: number;
      readonly condition: number;
      readonly model: 'mechanical' | 'electrical';
    }
  | {
      readonly ok: false;
      readonly code: 'DRV_FIT_UNIDENTIFIABLE' | 'DRV_FIT_DATA';
      readonly why: string;
      readonly confounded: readonly string[];
    };

const fail = (code: 'DRV_FIT_UNIDENTIFIABLE' | 'DRV_FIT_DATA', why: string, confounded: readonly string[] = []): FitResult => ({
  ok: false,
  code,
  why,
  confounded,
});

/** The pair of columns with the largest |cosine| (the most confounded unknowns). */
function mostConfounded(names: readonly string[], columns: readonly (readonly number[])[]): readonly string[] {
  const norm = (c: readonly number[]): number => Math.sqrt(c.reduce((sum, v) => sum + v * v, 0));
  let best: readonly string[] = names.slice(0, 2);
  let bestCosine = -1;
  for (let a = 0; a < columns.length; a++)
    for (let b = a + 1; b < columns.length; b++) {
      const [ca, cb] = [columns[a] ?? [], columns[b] ?? []];
      const denominator = norm(ca) * norm(cb);
      const cosine = denominator > 0 ? Math.abs(ca.reduce((sum, v, k) => sum + v * elementAt(cb, k), 0)) / denominator : 0;
      if (cosine > bestCosine) [best, bestCosine] = [[names[a] ?? '', names[b] ?? ''], cosine];
    }
  return best;
}

/** Solve y = X theta for the named unknowns; rows are the equations. */
function solve(
  model: 'mechanical' | 'electrical',
  names: readonly string[],
  rows: readonly (readonly number[])[],
  y: readonly number[],
): FitResult {
  const [n, p] = [rows.length, names.length];
  if (n < p) return fail('DRV_FIT_DATA', `${n} usable sample(s) cannot determine ${p} unknowns`);
  const solution = solveLeastSquares(rows, y);
  const columns = names.map((_, j) => rows.map((row) => row[j] ?? 0));
  if (!Number.isFinite(solution.conditionEstimate) || solution.conditionEstimate > MAX_CONDITION)
    return fail(
      'DRV_FIT_UNIDENTIFIABLE',
      `the regressor of ${names.join(', ')} has condition number ${solution.conditionEstimate.toExponential(2)} (limit ${MAX_CONDITION.toExponential(0)}): the data cannot separate them`,
      p === 1 ? names : mostConfounded(names, columns),
    );
  const residual = rows.map((row, k) => elementAt(y, k) - row.reduce((sum, v, j) => sum + v * elementAt(solution.coefficients, j), 0));
  const rss = residual.reduce((sum, r) => sum + r * r, 0);
  let sigmas: (number | null)[] = names.map(() => null);
  if (n > p) {
    const normal = names.map((_, a) =>
      names.map((__, b) => elementAt(columns, a).reduce((sum, v, k) => sum + v * elementAt(elementAt(columns, b), k), 0)),
    );
    const inverse = invertDense(normal);
    const variance = rss / (n - p);
    if (inverse !== null) sigmas = names.map((_, j) => Math.sqrt(Math.max(0, variance * (inverse[j]?.[j] ?? 0))));
  }
  return {
    ok: true,
    values: Object.fromEntries(names.map((name, j) => [name, { value: solution.coefficients[j] ?? Number.NaN, sigma: sigmas[j] ?? null }])),
    residualRms: Math.sqrt(rss / n),
    samplesUsed: n,
    condition: solution.conditionEstimate,
    model,
  };
}

const finiteAll = (values: readonly number[]): boolean => values.every(Number.isFinite);

/** Mechanical fit: unknowns among inertia, coulombNm, viscousNmsPerRad; `known` fixes the others. */
export function fitMechanical(channels: Channels, unknowns: readonly string[], known: Readonly<Record<string, number>>): FitResult {
  const { t, omega } = channels;
  if (t.length !== omega.length || t.length < 3 || !finiteAll(t) || !finiteAll(omega))
    return fail('DRV_FIT_DATA', 'omega needs at least 3 finite samples and one time per sample');
  if (channels.torque !== undefined && channels.torque.length !== t.length) return fail('DRV_FIT_DATA', 'torque needs one value per time');
  if (t.some((time, k) => k > 0 && time <= (t[k - 1] ?? Number.NaN))) return fail('DRV_FIT_DATA', 't must be strictly increasing');
  // J w' + T_f s + b w = tau: with no torque, no unknown fixes the scale of the homogeneous equation
  if (unknowns.includes('inertia') && channels.torque === undefined)
    return fail(
      'DRV_FIT_UNIDENTIFIABLE',
      'with the inertia unknown and no measured torque the spin-down equation is homogeneous: every parameter can be scaled together (J and the friction are confounded)',
      ['inertia', unknowns.find((name) => name !== 'inertia') ?? 'inertia'],
    );
  const floor = MOVING_FRACTION * omega.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  const rows: number[][] = [];
  const y: number[] = [];
  for (let k = 1; k < t.length - 1; k++) {
    const [before, here, after] = [elementAt(omega, k - 1), elementAt(omega, k), elementAt(omega, k + 1)];
    if (![before, here, after].every((v) => Math.abs(v) > floor) || Math.sign(before) !== Math.sign(after)) continue;
    const alpha = (after - before) / (elementAt(t, k + 1) - elementAt(t, k - 1));
    const regressor: Readonly<Record<string, number>> = { inertia: alpha, coulombNm: Math.sign(here), viscousNmsPerRad: here };
    const torque = channels.torque === undefined ? 0 : (channels.torque[k] ?? 0);
    rows.push(unknowns.map((name) => regressor[name] ?? 0));
    y.push(torque - Object.entries(known).reduce((sum, [name, value]) => sum + value * (regressor[name] ?? 0), 0));
  }
  return solve('mechanical', unknowns, rows, y);
}

/** Electrical fit: unknowns among resistance, torqueConstant; `known.inductance` adds the L di/dt term (absent = neglected, said by the caller). */
export function fitElectrical(channels: Channels, unknowns: readonly string[], known: Readonly<Record<string, number>>): FitResult {
  const { t, omega, current, voltage } = channels;
  if (current === undefined || voltage === undefined)
    return fail('DRV_FIT_DATA', 'the electrical fit needs current and voltage series besides omega');
  if (
    ![omega, current, voltage].every((series) => series.length === t.length) ||
    t.length < 3 ||
    ![t, omega, current, voltage].every(finiteAll)
  )
    return fail('DRV_FIT_DATA', 'omega, current and voltage need at least 3 finite samples and one time per sample');
  if (t.some((time, k) => k > 0 && time <= (t[k - 1] ?? Number.NaN))) return fail('DRV_FIT_DATA', 't must be strictly increasing');
  const inductance = known['inductance'];
  const first = inductance === undefined ? 0 : 1;
  const rows: number[][] = [];
  const y: number[] = [];
  for (let k = first; k < t.length - first; k++) {
    const slope =
      inductance === undefined ? 0 : (elementAt(current, k + 1) - elementAt(current, k - 1)) / (elementAt(t, k + 1) - elementAt(t, k - 1));
    const regressor: Readonly<Record<string, number>> = { resistance: elementAt(current, k), torqueConstant: elementAt(omega, k) };
    rows.push(unknowns.map((name) => regressor[name] ?? 0));
    y.push(
      (voltage[k] ?? 0) -
        (inductance === undefined ? 0 : inductance * slope) -
        Object.entries(known).reduce((sum, [name, value]) => sum + value * (regressor[name] ?? 0), 0),
    );
  }
  return solve('electrical', unknowns, rows, y);
}
