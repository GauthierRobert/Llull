/**
 * Non-linear fits of the non-hyperelastic laws (PHY-02 §5.7, V2): Prony series with free relaxation times, Ramberg-Osgood in the true-stress
 * form E ε = σ + α (|σ|/σ0)^(n−1) σ, Voce isotropic hardening, monotonic Chaboche (Armstrong-Frederick) back stresses and Garofalo creep.
 * Each law is linear in some parameters for fixed others: starts solve those by QR, Levenberg-Marquardt refines all parameters.
 */

import { solveLeastSquares } from '../../lib/leastSquares';
import { GAS_CONSTANT } from '../propertyForms';
import { garofaloRate } from './creep';
import { summarise, type Residual } from './fit';
import { fitFailureOr, type NonlinearBase } from './fitCommon';
import { searchFit, type FitControl, type ParamSpec } from './fitSearch';
import { failure, type LawFailure } from './resolve';
import { pronyRatio } from './viscoelastic';

type Rows = ReadonlyArray<readonly [number, number]>;

export interface LawFit extends NonlinearBase {
  readonly perTest: readonly (Residual & { readonly mode: string })[];
}

const sumSquares = (values: readonly number[]): number => values.reduce((sum, value) => sum + value * value, 0);

const stats = (mode: string, residuals: readonly number[]): Residual & { readonly mode: string } => ({
  mode,
  rms: Math.sqrt(sumSquares(residuals) / Math.max(residuals.length, 1)),
  maxAbs: Math.max(0, ...residuals.map(Math.abs)),
  count: residuals.length,
});

const finiteOrNull = (values: number[]): number[] | null => (values.every(Number.isFinite) ? values : null);

const insufficient = (rows: number, parameters: number): LawFailure =>
  failure('MATL_FIT_INSUFFICIENT_DATA', 'tests', `${rows} rows for ${parameters} parameters`, 'add data or use fewer terms');

/**
 * Prony series with free relaxation times: G(t)/G0 = 1 − Σ g_i (1 − e^(−t/τ_i)); parameters g1…gN (≥ 1e-9) and tau1…tauN (s, searched as ln τ).
 * @param rows [t > 0 (s), G(t) (any consistent unit)]
 * @failure see `searchFit`; Σ g ≥ 1 -> MATL_PRONY_INVALID
 */
export function fitPronyFreeTau(rows: Rows, G0: number, terms: number, weight: number, control: FitControl): LawFit | LawFailure {
  if (rows.length <= 2 * terms) return insufficient(rows.length, 2 * terms);
  const times = rows.map(([t]) => t);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const specs: ParamSpec[] = [
    ...Array.from({ length: terms }, (_, k) => ({ name: `g${k + 1}`, lower: 1e-9, upper: 1 })),
    ...Array.from({ length: terms }, (_, k) => ({ name: `tau${k + 1}`, lower: tMin / 100, upper: tMax * 100, log: true })),
  ];
  const ratio = (values: readonly number[], t: number): number => pronyRatio(values.slice(0, terms), values.slice(terms), t);
  const starts: number[][] = [];
  for (const spread of [1, 3, 10]) {
    const lo = tMin * spread;
    const hi = tMax / spread;
    const tau = Array.from({ length: terms }, (_, i) =>
      lo < hi && terms > 1 ? lo * (hi / lo) ** (i / (terms - 1)) : Math.sqrt(lo * hi > 0 ? lo * hi : tMin * tMax),
    );
    const fit = solveLeastSquares(
      rows.map(([t]) => tau.map((value) => 1 - Math.exp(-t / value))),
      rows.map(([, modulus]) => 1 - modulus / G0),
    );
    if (!Number.isFinite(fit.conditionEstimate)) continue;
    const g = fit.coefficients.map((value) => Math.max(value, 1e-3 / terms));
    const total = g.reduce((sum, value) => sum + value, 0);
    starts.push([...(total > 0.9 ? g.map((value) => (value * 0.9) / total) : g), ...tau]);
  }
  const outcome = searchFit(
    specs,
    starts,
    (values) => finiteOrNull(rows.map(([t, modulus]) => Math.sqrt(weight) * (ratio(values, t) - modulus / G0))),
    control,
  );
  return fitFailureOr(outcome, (values, report) => {
    const order = Array.from({ length: terms }, (_, k) => k).sort((a, b) => (values[terms + a] ?? 0) - (values[terms + b] ?? 0));
    const g = order.map((k) => values[k] ?? 0);
    const tau = order.map((k) => values[terms + k] ?? 1);
    if (g.reduce((sum, value) => sum + value, 0) >= 1)
      return failure(
        'MATL_PRONY_INVALID',
        'law',
        `fitted weights ${g.map((value) => value.toPrecision(5)).join(', ')} sum to ≥ 1`,
        'use fewer terms or bound the weights',
      );
    const residuals = rows.map(([t, modulus]) => pronyRatio(g, tau, t) - modulus / G0);
    return {
      law: { kind: 'visco_prony', shear: g.map((value, i) => ({ g: value, tau: { value: tau[i], unit: 's' } })) },
      summary: summarise(
        residuals,
        rows.map(([, modulus]) => modulus / G0),
        report.conditionNumber,
      ),
      perTest: [stats('relaxation', residuals)],
      convergence: report,
      range: { variable: 'time', unit: 's', data: [tMin, tMax] },
    };
  });
}

/**
 * Ramberg-Osgood true-stress form E ε = σ + α (|σ|/σ0)^(n−1) σ with E, ν, σ0 fixed (α and σ0 are degenerate): parameters alpha, n.
 * @param rows [total strain, true stress (MPa)]
 * @failure see `searchFit`; fewer than 3 rows with σ ≠ 0 -> MATL_FIT_INSUFFICIENT_DATA
 */
export function fitRambergOsgoodTrue(
  rows: Rows,
  E: number,
  nu: number,
  sigma0: number,
  weight: number,
  control: FitControl,
): (LawFit & { readonly plasticStrainMax: number }) | LawFailure {
  const usable = rows.filter(([, stress]) => stress !== 0);
  if (usable.length < 3) return insufficient(usable.length, 2);
  const strain = (alpha: number, n: number, stress: number): number =>
    stress / E + (alpha / E) * (Math.abs(stress) / sigma0) ** (n - 1) * stress;
  const specs: ParamSpec[] = [
    { name: 'alpha', lower: 1e-9, upper: Number.POSITIVE_INFINITY },
    { name: 'n', lower: 1.001, upper: 300 },
  ];
  const starts: number[][] = [];
  for (const n of [2, 3, 5, 10, 20, 40]) {
    const basis = usable.map(([, stress]) => ((Math.abs(stress) / sigma0) ** (n - 1) * stress) / E);
    const plastic = usable.map(([e, stress]) => e - stress / E);
    const alpha = basis.reduce((sum, b, i) => sum + b * (plastic[i] ?? 0), 0) / Math.max(sumSquares(basis), Number.MIN_VALUE);
    starts.push([Math.max(alpha, 1e-6), n]);
  }
  const outcome = searchFit(
    specs,
    starts,
    (values) => finiteOrNull(usable.map(([e, stress]) => Math.sqrt(weight) * (strain(values[0] ?? 0, values[1] ?? 2, stress) - e))),
    control,
  );
  return fitFailureOr(outcome, (values, report) => {
    const [alpha = 0, n = 2] = values;
    const residuals = rows.map(([e, stress]) => strain(alpha, n, stress) - e);
    return {
      law: {
        kind: 'ramberg_osgood',
        form: 'calculix',
        E: { value: E, unit: 'MPa' },
        nu: { value: nu, unit: '1' },
        sigma0: { value: sigma0, unit: 'MPa' },
        n,
        alpha,
      },
      summary: summarise(
        residuals,
        rows.map(([e]) => e),
        report.conditionNumber,
      ),
      perTest: [stats('uniaxial_plastic', residuals)],
      convergence: report,
      range: { variable: 'equivalentPlasticStrain', unit: '1', data: [0, Math.max(...usable.map(([e, stress]) => e - stress / E), 0)] },
      plasticStrainMax: Math.max(...usable.map(([e, stress]) => e - stress / E), 0),
    };
  });
}

const hardeningRange = (rows: Rows): NonlinearBase['range'] => ({
  variable: 'equivalentPlasticStrain',
  unit: '1',
  data: [Math.min(...rows.map(([e]) => e)), Math.max(...rows.map(([e]) => e))],
});

/**
 * Voce isotropic hardening σ = σy + Q (1 − e^(−b ε_p)): parameters sigmaY, Q, b.
 * @param rows [equivalent plastic strain, true stress (MPa)]
 * @failure see `searchFit`; rows ≤ 3 -> MATL_FIT_INSUFFICIENT_DATA
 */
export function fitVoce(rows: Rows, weight: number, control: FitControl): LawFit | LawFailure {
  if (rows.length <= 3) return insufficient(rows.length, 3);
  const specs: ParamSpec[] = [
    { name: 'sigmaY', lower: 1e-9, upper: Number.POSITIVE_INFINITY },
    { name: 'Q', lower: 0, upper: Number.POSITIVE_INFINITY },
    { name: 'b', lower: 1e-6, upper: 1e6 },
  ];
  const model = (values: readonly number[], strain: number): number =>
    (values[0] ?? 0) + (values[1] ?? 0) * (1 - Math.exp(-(values[2] ?? 0) * strain));
  const starts: number[][] = [];
  const strainMax = Math.max(...rows.map(([e]) => e), Number.MIN_VALUE);
  for (const b of [1 / strainMax, 5 / strainMax, 20 / strainMax, 100 / strainMax]) {
    const fit = solveLeastSquares(
      rows.map(([e]) => [1, 1 - Math.exp(-b * e)]),
      rows.map(([, stress]) => stress),
    );
    if (Number.isFinite(fit.conditionEstimate))
      starts.push([Math.max(fit.coefficients[0] ?? 0, 1e-6), Math.max(fit.coefficients[1] ?? 0, 0), b]);
  }
  const outcome = searchFit(
    specs,
    starts,
    (values) => finiteOrNull(rows.map(([e, stress]) => Math.sqrt(weight) * (model(values, e) - stress))),
    control,
  );
  return fitFailureOr(outcome, (values, report) => {
    const residuals = rows.map(([e, stress]) => model(values, e) - stress);
    return {
      law: {
        kind: 'j2_plasticity',
        isotropic: { kind: 'voce', yieldStress: { value: values[0], unit: 'MPa' }, Q: { value: values[1], unit: 'MPa' }, b: values[2] },
        kinematic: { kind: 'none' },
      },
      summary: summarise(
        residuals,
        rows.map(([, stress]) => stress),
        report.conditionNumber,
      ),
      perTest: [stats('uniaxial_plastic', residuals)],
      convergence: report,
      range: hardeningRange(rows),
    };
  });
}

const GAMMA_GRID = [1, 10, 100, 1000] as const;

/**
 * Monotonic Chaboche (Armstrong-Frederick) hardening σ = σy + Σ (C_i/γ_i)(1 − e^(−γ_i ε_p)) with σy fixed (monotonic data cannot separate it):
 * parameters C1…CN (MPa) and gamma1…gammaN, γ ascending. Cyclic (Bauschinger) behaviour is NOT identified by monotonic data.
 * @param rows [equivalent plastic strain, true stress (MPa)]
 * @failure see `searchFit`; rows ≤ 2N -> MATL_FIT_INSUFFICIENT_DATA
 */
export function fitChaboche(rows: Rows, yieldStress: number, terms: number, weight: number, control: FitControl): LawFit | LawFailure {
  if (rows.length <= 2 * terms) return insufficient(rows.length, 2 * terms);
  const specs: ParamSpec[] = [
    ...Array.from({ length: terms }, (_, k) => ({ name: `C${k + 1}`, lower: 0, upper: Number.POSITIVE_INFINITY })),
    ...Array.from({ length: terms }, (_, k) => ({ name: `gamma${k + 1}`, lower: 1e-6, upper: 1e5 })),
  ];
  const model = (values: readonly number[], strain: number): number =>
    yieldStress +
    values
      .slice(0, terms)
      .reduce((sum, C, i) => sum + (C / (values[terms + i] ?? 1)) * (1 - Math.exp(-(values[terms + i] ?? 1) * strain)), 0);
  const starts: number[][] = [];
  const picks = (from: number, chosen: number[]): number[][] =>
    chosen.length === terms ? [chosen] : GAMMA_GRID.flatMap((_, i) => (i >= from ? picks(i + 1, [...chosen, i]) : []));
  for (const combo of picks(0, [])) {
    const gamma = combo.map((index) => GAMMA_GRID[index] ?? 1);
    const fit = solveLeastSquares(
      rows.map(([e]) => gamma.map((g) => (1 - Math.exp(-g * e)) / g)),
      rows.map(([, stress]) => stress - yieldStress),
    );
    if (Number.isFinite(fit.conditionEstimate)) starts.push([...fit.coefficients.map((value) => Math.max(value, 1e-3)), ...gamma]);
  }
  const outcome = searchFit(
    specs,
    starts,
    (values) => finiteOrNull(rows.map(([e, stress]) => Math.sqrt(weight) * (model(values, e) - stress))),
    control,
  );
  return fitFailureOr(outcome, (values, report) => {
    const order = Array.from({ length: terms }, (_, k) => k).sort((a, b) => (values[terms + a] ?? 0) - (values[terms + b] ?? 0));
    const ordered = [...order.map((k) => values[k] ?? 0), ...order.map((k) => values[terms + k] ?? 1)];
    const residuals = rows.map(([e, stress]) => model(ordered, e) - stress);
    return {
      law: {
        kind: 'j2_plasticity',
        isotropic: { kind: 'perfect', yieldStress: { value: yieldStress, unit: 'MPa' } },
        kinematic: {
          kind: 'chaboche',
          backstresses: order.map((k) => ({ C: { value: values[k], unit: 'MPa' }, gamma: values[terms + k] })),
        },
      },
      summary: summarise(
        residuals,
        rows.map(([, stress]) => stress),
        report.conditionNumber,
      ),
      perTest: [stats('uniaxial_plastic', residuals)],
      convergence: report,
      range: hardeningRange(rows),
      notes: [
        {
          code: 'MATL_FIT_MONOTONIC_ONLY',
          message:
            'monotonic data fix the saturation C_i/γ_i and γ_i but not the cyclic Bauschinger response: confirm with a reverse-loading test',
        },
      ],
    };
  });
}

/**
 * Garofalo creep rate ε̇ = A [sinh(ασ)]^n exp(−Q/(R T)) by least squares on ln ε̇: parameters A (1/s), alpha (1/MPa), n and, unless fixed,
 * activationEnergy (J/mol; needs two or more temperatures).
 * @param rows [stress (MPa), temperature (K), steady creep rate (1/s)]; every value > 0
 * @failure see `searchFit`; rows ≤ parameters -> MATL_FIT_INSUFFICIENT_DATA
 */
export function fitGarofalo(
  rows: ReadonlyArray<readonly [number, number, number]>,
  fixedActivationEnergy: number | null,
  weight: number,
  control: FitControl,
): LawFit | LawFailure {
  const freeEnergy = fixedActivationEnergy === null;
  const count = freeEnergy ? 4 : 3;
  if (rows.length <= count) return insufficient(rows.length, count);
  const specs: ParamSpec[] = [
    { name: 'A', lower: 1e-80, upper: 1e80, log: true },
    { name: 'alpha', lower: 1e-6, upper: 10 },
    { name: 'n', lower: 0.5, upper: 40 },
    ...(freeEnergy ? [{ name: 'activationEnergy', lower: 0, upper: 1e6 }] : []),
  ];
  const energyOf = (values: readonly number[]): number => fixedActivationEnergy ?? values[3] ?? 0;
  const logRate = (values: readonly number[], [stress, T]: readonly [number, number, number]): number =>
    Math.log(garofaloRate(values[0] ?? 1, values[1] ?? 1, values[2] ?? 1, energyOf(values), stress, T));
  const starts: number[][] = [];
  for (const n of [3, 5, 8]) {
    for (const alpha of [0.005, 0.02, 0.1]) {
      for (const energy of freeEnergy ? [1e5, 3e5] : [0]) {
        const lnA =
          rows.reduce(
            (sum, [stress, T, rate]) =>
              sum + Math.log(rate) - n * Math.log(Math.sinh(alpha * stress)) + (fixedActivationEnergy ?? energy) / (GAS_CONSTANT * T),
            0,
          ) / rows.length;
        starts.push([Math.exp(lnA), alpha, n, ...(freeEnergy ? [energy] : [])]);
      }
    }
  }
  const outcome = searchFit(
    specs,
    starts,
    (values) => finiteOrNull(rows.map((row) => Math.sqrt(weight) * (logRate(values, row) - Math.log(row[2])))),
    control,
  );
  return fitFailureOr(outcome, (values, report) => {
    const residuals = rows.map((row) => logRate(values, row) - Math.log(row[2]));
    const temperatures = rows.map(([, T]) => T);
    return {
      law: {
        kind: 'creep_garofalo',
        A: { value: values[0], unit: '1/s' },
        alpha: { value: values[1], unit: '1/MPa' },
        n: values[2],
        activationEnergy: { value: energyOf(values), unit: 'J/mol' },
      },
      summary: summarise(
        residuals,
        rows.map(([, , rate]) => Math.log(rate)),
        report.conditionNumber,
      ),
      perTest: [stats('creep_rate_ln', residuals)],
      convergence: report,
      range: { variable: 'T', unit: 'K', data: [Math.min(...temperatures), Math.max(...temperatures)] },
    };
  });
}
