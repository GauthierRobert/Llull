/**
 * Linear-in-parameters fits (PHY-02 §5.7): hyperelastic polynomial family (Neo-Hooke, Mooney-Rivlin, Yeoh, polynomial, reduced polynomial)
 * on exact model rows by Householder QR, Ramberg-Osgood on log-log plastic strain, Prony series with fixed relaxation times.
 * Deterministic; no non-linear fits (V2).
 */

import { solveLeastSquares } from '../../lib/leastSquares';
import { nominalStress, polynomialDerivatives, type HyperMode, type ResolvedHyper } from './hyperelastic';
import { failure, type LawFailure } from './resolve';

export type FitObjective = 'absolute' | 'relative';
export type HyperFitKind = 'hyper_neo_hooke' | 'hyper_mooney_rivlin' | 'hyper_yeoh' | 'hyper_polynomial' | 'hyper_reduced_polynomial';

export interface HyperTest {
  readonly mode: HyperMode;
  /** [stretch, nominal stress in MPa] rows. */
  readonly rows: ReadonlyArray<readonly [number, number]>;
  readonly weight: number;
}

interface Residual {
  readonly rms: number;
  readonly maxAbs: number;
  readonly count: number;
}

interface FitSummary {
  readonly rms: number;
  readonly maxAbs: number;
  readonly maxRel: number;
  readonly rSquared: number;
  readonly points: number;
  readonly conditionNumber: number;
}

export interface HyperFit {
  readonly law: Record<string, unknown>;
  readonly resolved: ResolvedHyper;
  readonly perTest: readonly (Residual & { readonly mode: HyperMode })[];
  readonly summary: FitSummary;
  readonly stretchRange: readonly [number, number];
}

const HYPER_TERMS: Readonly<Record<HyperFitKind, (order: number) => ReadonlyArray<readonly [number, number, string]>>> = {
  hyper_neo_hooke: () => [[1, 0, 'C10']],
  hyper_mooney_rivlin: () => [
    [1, 0, 'C10'],
    [0, 1, 'C01'],
  ],
  hyper_yeoh: () => [
    [1, 0, 'C10'],
    [2, 0, 'C20'],
    [3, 0, 'C30'],
  ],
  hyper_polynomial: (order) =>
    (
      [
        [1, 0, 'C10'],
        [0, 1, 'C01'],
        [2, 0, 'C20'],
        [1, 1, 'C11'],
        [0, 2, 'C02'],
        [3, 0, 'C30'],
        [2, 1, 'C21'],
        [1, 2, 'C12'],
        [0, 3, 'C03'],
      ] as const
    ).filter(([i, j]) => i + j <= order),
  hyper_reduced_polynomial: (order) => Array.from({ length: order }, (_, k) => [k + 1, 0, `C${k + 1}0`] as const),
};

const sumSquares = (values: readonly number[]): number => values.reduce((sum, value) => sum + value * value, 0);

const summarise = (residuals: readonly number[], observed: readonly number[], conditionNumber: number): FitSummary => {
  const mean = observed.reduce((sum, y) => sum + y, 0) / Math.max(observed.length, 1);
  const total = observed.reduce((sum, y) => sum + (y - mean) ** 2, 0);
  const relative = residuals.flatMap((r, i) => ((observed[i] ?? 0) !== 0 ? [Math.abs(r / (observed[i] ?? 1))] : []));
  return {
    rms: Math.sqrt(sumSquares(residuals) / Math.max(residuals.length, 1)),
    maxAbs: Math.max(0, ...residuals.map(Math.abs)),
    maxRel: Math.max(0, ...relative),
    rSquared: total > 0 ? 1 - sumSquares(residuals) / total : 1,
    points: residuals.length,
    conditionNumber,
  };
};

/**
 * Fit the coefficients of a polynomial-family law to nominal stress vs stretch rows of the given modes (P is linear in the C_ij).
 * @failure rows ≤ parameters -> MATL_FIT_INSUFFICIENT_DATA; condition number > 1e12 -> MATL_FIT_ILL_CONDITIONED
 */
export function fitHyperelastic(
  kind: HyperFitKind,
  order: number,
  tests: readonly HyperTest[],
  objective: FitObjective,
): HyperFit | LawFailure {
  const terms = HYPER_TERMS[kind](order);
  const design: number[][] = [];
  const target: number[] = [];
  const weights: number[] = [];
  for (const test of tests) {
    for (const [stretch, stress] of test.rows) {
      if (objective === 'relative' && stress === 0) continue;
      design.push(
        terms.map(([i, j]) =>
          nominalStress({ kind: 'invariant', derivatives: polynomialDerivatives([[i, j, 1]]), shearModulus: 1 }, test.mode, stretch),
        ),
      );
      target.push(stress);
      weights.push(objective === 'relative' ? test.weight / stress ** 2 : test.weight);
    }
  }
  if (target.length <= terms.length)
    return failure(
      'MATL_FIT_INSUFFICIENT_DATA',
      'tests',
      `${target.length} rows for ${terms.length} parameters`,
      'add data or a simpler law',
    );
  const solution = solveLeastSquares(design, target, weights);
  if (!(solution.conditionEstimate <= 1e12))
    return failure(
      'MATL_FIT_ILL_CONDITIONED',
      'law',
      `condition number ${solution.conditionEstimate.toExponential(2)} > 1e12 after scaling`,
      'use a simpler law',
    );
  const coefficients = solution.coefficients;
  const resolved: ResolvedHyper = {
    kind: 'invariant',
    derivatives: polynomialDerivatives(terms.map(([i, j], k) => [i, j, coefficients[k] ?? 0] as const)),
    shearModulus: 2 * terms.reduce((sum, [i, j], k) => (i + j === 1 ? sum + (coefficients[k] ?? 0) : sum), 0),
  };
  const perTest = tests.map((test) => {
    const residuals = test.rows.map(([stretch, stress]) => nominalStress(resolved, test.mode, stretch) - stress);
    return {
      mode: test.mode,
      rms: Math.sqrt(sumSquares(residuals) / Math.max(residuals.length, 1)),
      maxAbs: Math.max(0, ...residuals.map(Math.abs)),
      count: residuals.length,
    };
  });
  const residuals = tests.flatMap((test) => test.rows.map(([stretch, stress]) => nominalStress(resolved, test.mode, stretch) - stress));
  const observed = tests.flatMap((test) => test.rows.map(([, stress]) => stress));
  const stretches = tests.flatMap((test) => test.rows.map(([stretch]) => stretch));
  const value = (key: string): number => coefficients[terms.findIndex(([, , name]) => name === key)] ?? 0;
  const quantity = (key: string): { value: number; unit: string } => ({ value: value(key), unit: 'MPa' });
  const zeros = (count: number): number[] => new Array<number>(count).fill(0);
  let law: Record<string, unknown>;
  switch (kind) {
    case 'hyper_neo_hooke':
      law = { kind, C10: quantity('C10'), D1: { value: 0, unit: '1/MPa' } };
      break;
    case 'hyper_mooney_rivlin':
      law = { kind, C10: quantity('C10'), C01: quantity('C01'), D1: { value: 0, unit: '1/MPa' } };
      break;
    case 'hyper_yeoh':
      law = { kind, C10: quantity('C10'), C20: quantity('C20'), C30: quantity('C30'), D: [0, 0, 0], compliance: '1/MPa' };
      break;
    case 'hyper_polynomial':
      law = {
        kind,
        order,
        C: Object.fromEntries(terms.map(([, , name], k) => [name, coefficients[k] ?? 0])),
        D: zeros(order),
        stressUnit: 'MPa',
      };
      break;
    case 'hyper_reduced_polynomial':
      law = { kind, order, Ci0: terms.map((_, k) => coefficients[k] ?? 0), D: zeros(order), stressUnit: 'MPa' };
      break;
  }
  return {
    law,
    resolved,
    perTest,
    summary: summarise(residuals, observed, solution.conditionEstimate),
    stretchRange: [Math.min(...stretches), Math.max(...stretches)],
  };
}

export interface RambergOsgoodFit {
  readonly law: Record<string, unknown>;
  readonly summary: FitSummary;
  readonly perTest: readonly (Residual & { readonly mode: 'uniaxial_plastic' })[];
  /** Largest plastic strain ε − σ/E of the usable rows (upper bound of the equivalent-plastic-strain validity). */
  readonly plasticStrainMax: number;
}

/**
 * Ramberg-Osgood engineering form ε = σ/E + 0.002 (σ/σ0.2)^n: ln(ε − σ/E) = ln 0.002 + n ln σ − n ln σ0.2 by linear regression.
 * @failure fewer than 3 usable rows (σ > 0, ε − σ/E > 0) -> MATL_FIT_INSUFFICIENT_DATA; slope n ≤ 1 -> MATL_FIT_ILL_CONDITIONED
 */
export function fitRambergOsgood(
  rows: ReadonlyArray<readonly [number, number]>,
  youngModulus: number,
  poisson: number,
  weight: number,
): RambergOsgoodFit | LawFailure {
  const usable = rows.filter(([strain, stress]) => stress > 0 && strain - stress / youngModulus > 0);
  if (usable.length < 3)
    return failure(
      'MATL_FIT_INSUFFICIENT_DATA',
      'tests',
      `${usable.length} rows with σ > 0 and plastic strain > 0 for 2 parameters`,
      'add points beyond the proportional limit',
    );
  const design = usable.map(([, stress]) => [1, Math.log(stress)]);
  const target = usable.map(([strain, stress]) => Math.log(strain - stress / youngModulus));
  const solution = solveLeastSquares(
    design,
    target,
    usable.map(() => weight),
  );
  if (!(solution.conditionEstimate <= 1e12))
    return failure(
      'MATL_FIT_ILL_CONDITIONED',
      'law',
      'the plastic strains do not span a range of stress',
      'use points over a wider stress range',
    );
  const [intercept = 0, n = 0] = solution.coefficients;
  if (!(n > 1))
    return failure(
      'MATL_FIT_ILL_CONDITIONED',
      'law',
      `fitted exponent n = ${n} must be > 1`,
      'check that the rows are (total strain, stress) beyond yield',
    );
  const sigma02 = Math.exp((Math.log(0.002) - intercept) / n);
  const residuals = rows.map(([strain, stress]) => stress / youngModulus + 0.002 * (stress / sigma02) ** n - strain);
  const observed = rows.map(([strain]) => strain);
  return {
    law: {
      kind: 'ramberg_osgood',
      form: 'engineering',
      E: { value: youngModulus, unit: 'MPa' },
      nu: { value: poisson, unit: '1' },
      sigma02: { value: sigma02, unit: 'MPa' },
      n,
    },
    summary: summarise(residuals, observed, solution.conditionEstimate),
    perTest: [
      {
        mode: 'uniaxial_plastic',
        rms: Math.sqrt(sumSquares(residuals) / residuals.length),
        maxAbs: Math.max(...residuals.map(Math.abs)),
        count: residuals.length,
      },
    ],
    plasticStrainMax: Math.max(...usable.map(([strain, stress]) => strain - stress / youngModulus)),
  };
}

export interface PronyFit {
  readonly law: Record<string, unknown>;
  readonly summary: FitSummary;
  readonly perTest: readonly (Residual & { readonly mode: 'relaxation' })[];
  readonly timeRange: readonly [number, number];
}

/**
 * Prony weights g_i of fixed relaxation times τ_i (s) from G(t)/G0 = 1 − Σ g_i (1 − e^(−t/τ_i)).
 * @failure rows ≤ terms -> MATL_FIT_INSUFFICIENT_DATA; g_i ≤ 0 or Σ g ≥ 1 -> MATL_PRONY_INVALID
 */
export function fitProny(
  rows: ReadonlyArray<readonly [number, number]>,
  G0: number,
  tauSeconds: readonly number[],
  weight: number,
): PronyFit | LawFailure {
  if (rows.length <= tauSeconds.length)
    return failure(
      'MATL_FIT_INSUFFICIENT_DATA',
      'tests',
      `${rows.length} rows for ${tauSeconds.length} parameters`,
      'add relaxation data or use fewer terms',
    );
  const design = rows.map(([t]) => tauSeconds.map((tau) => 1 - Math.exp(-t / tau)));
  const target = rows.map(([, modulus]) => 1 - modulus / G0);
  const solution = solveLeastSquares(
    design,
    target,
    rows.map(() => weight),
  );
  if (!(solution.conditionEstimate <= 1e12))
    return failure(
      'MATL_FIT_ILL_CONDITIONED',
      'law',
      'the relaxation times are not resolved by the data',
      'use fewer or better separated times',
    );
  const g = solution.coefficients;
  if (g.some((value) => !(value > 0)) || g.reduce((sum, value) => sum + value, 0) >= 1)
    return failure(
      'MATL_PRONY_INVALID',
      'law',
      `fitted weights ${g.map((value) => value.toPrecision(5)).join(', ')} violate g > 0 and Σg < 1`,
      'choose other relaxation times',
    );
  const residuals = rows.map(
    ([t, modulus]) => 1 - g.reduce((sum, gi, i) => sum + gi * (1 - Math.exp(-t / (tauSeconds[i] ?? 1))), 0) - modulus / G0,
  );
  const times = rows.map(([t]) => t);
  return {
    law: { kind: 'visco_prony', shear: g.map((gi, i) => ({ g: gi, tau: { value: tauSeconds[i], unit: 's' } })) },
    summary: summarise(
      residuals,
      rows.map(([, modulus]) => modulus / G0),
      solution.conditionEstimate,
    ),
    perTest: [
      {
        mode: 'relaxation',
        rms: Math.sqrt(sumSquares(residuals) / residuals.length),
        maxAbs: Math.max(...residuals.map(Math.abs)),
        count: residuals.length,
      },
    ],
    timeRange: [Math.min(...times), Math.max(...times)],
  };
}
