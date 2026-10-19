/**
 * Non-linear hyperelastic fits (PHY-02 §5.7, V2): Ogden (N ≤ 3 terms, canonical CalculiX convention) and Arruda-Boyce to nominal stress vs
 * stretch rows of the three modes. P is linear in the shear terms for fixed exponents / locking stretch, so every start solves those by QR
 * (variable projection) and Levenberg-Marquardt refines all parameters together.
 */

import { solveLeastSquares } from '../../lib/leastSquares';
import { summarise, type FitObjective, type FitSummary, type HyperTest, type Residual } from './fit';
import { fitFailureOr, type NonlinearBase } from './fitCommon';
import { searchFit, type ConvergenceReport, type FitControl, type ParamSpec } from './fitSearch';
import { arrudaBoyceDerivatives, nominalStress, type HyperMode, type ResolvedHyper } from './hyperelastic';
import { failure, type LawFailure } from './resolve';

export interface NonlinearHyperFit extends NonlinearBase {
  readonly resolved: ResolvedHyper;
  readonly perTest: readonly (Residual & { readonly mode: HyperMode })[];
}

/** Exponent grid of the deterministic Ogden multi-start (TECHNICAL_SPEC §5.7). */
const OGDEN_ALPHA_GRID = [-2, 1, 2, 3, 5] as const;
const AB_LAMBDA_GRID = [1.5, 2, 3, 5, 10, 30] as const;

const sumSquares = (values: readonly number[]): number => values.reduce((sum, value) => sum + value * value, 0);

/** Increasing index combinations of size k from n, in lexicographic order. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const walk = (from: number, chosen: number[]): void => {
    if (chosen.length === k) {
      out.push(chosen);
      return;
    }
    for (let i = from; i < n; i += 1) walk(i + 1, [...chosen, i]);
  };
  walk(0, []);
  return out;
}

interface Rows {
  readonly tests: readonly HyperTest[];
  readonly objective: FitObjective;
}

/** Weighted residual (model − data) of one law over all rows; null when a value is not finite. */
function weightedResiduals(law: ResolvedHyper, { tests, objective }: Rows): number[] | null {
  const out: number[] = [];
  for (const test of tests) {
    for (const [stretch, stress] of test.rows) {
      if (objective === 'relative' && stress === 0) continue;
      const weight = objective === 'relative' ? test.weight / stress ** 2 : test.weight;
      const value = (nominalStress(law, test.mode, stretch) - stress) * Math.sqrt(weight);
      if (!Number.isFinite(value)) return null;
      out.push(value);
    }
  }
  return out;
}

function summarising(
  law: ResolvedHyper,
  tests: readonly HyperTest[],
  conditionNumber: number,
): Pick<NonlinearHyperFit, 'perTest' | 'summary' | 'range'> {
  const residuals = tests.flatMap((test) => test.rows.map(([stretch, stress]) => nominalStress(law, test.mode, stretch) - stress));
  const observed = tests.flatMap((test) => test.rows.map(([, stress]) => stress));
  const stretches = tests.flatMap((test) => test.rows.map(([stretch]) => stretch));
  return {
    perTest: tests.map((test) => {
      const r = test.rows.map(([stretch, stress]) => nominalStress(law, test.mode, stretch) - stress);
      return {
        mode: test.mode,
        rms: Math.sqrt(sumSquares(r) / Math.max(r.length, 1)),
        maxAbs: Math.max(0, ...r.map(Math.abs)),
        count: r.length,
      };
    }),
    summary: summarise(residuals, observed, conditionNumber) satisfies FitSummary,
    range: { variable: 'stretch', unit: '1', data: [Math.min(...stretches), Math.max(...stretches)] },
  };
}

/** Shear terms for fixed exponents: columns are the unit-μ nominal stresses of each term; null on a rank-deficient design. */
function linearTerms(rows: Rows, columnLaw: (k: number) => ResolvedHyper, count: number): number[] | null {
  const design: number[][] = [];
  const target: number[] = [];
  const weights: number[] = [];
  for (const test of rows.tests) {
    for (const [stretch, stress] of test.rows) {
      if (rows.objective === 'relative' && stress === 0) continue;
      design.push(Array.from({ length: count }, (_, k) => nominalStress(columnLaw(k), test.mode, stretch)));
      target.push(stress);
      weights.push(rows.objective === 'relative' ? test.weight / stress ** 2 : test.weight);
    }
  }
  const solution = solveLeastSquares(design, target, weights);
  return Number.isFinite(solution.conditionEstimate) ? [...solution.coefficients] : null;
}

/**
 * Fit an N-term Ogden series (W = Σ 2μ_i/α_i² (λ1^α_i + λ2^α_i + λ3^α_i − 3)) to nominal stress rows.
 * @param positive μ_i ≥ 0 (every term stiffens at small strain; default behaviour of the command)
 * @failure see `searchFit`; fewer rows than parameters -> MATL_FIT_INSUFFICIENT_DATA
 */
export function fitOgden(
  terms: number,
  tests: readonly HyperTest[],
  objective: FitObjective,
  positive: boolean,
  control: FitControl,
): NonlinearHyperFit | LawFailure {
  const rowCount = tests.reduce((sum, test) => sum + test.rows.length, 0);
  if (rowCount <= 2 * terms)
    return failure('MATL_FIT_INSUFFICIENT_DATA', 'tests', `${rowCount} rows for ${2 * terms} parameters`, 'add data or use fewer terms');
  const rows: Rows = { tests, objective };
  const peak = Math.max(...tests.flatMap((test) => test.rows.map(([, stress]) => Math.abs(stress))), 1e-12);
  const specs: ParamSpec[] = [
    ...Array.from({ length: terms }, (_, k) => ({
      name: `mu${k + 1}`,
      lower: positive ? 0 : Number.NEGATIVE_INFINITY,
      upper: Number.POSITIVE_INFINITY,
    })),
    ...Array.from({ length: terms }, (_, k) => ({ name: `alpha${k + 1}`, lower: -30, upper: 30 })),
  ];
  const law = (values: readonly number[]): ResolvedHyper => {
    const mu = values.slice(0, terms);
    return { kind: 'ogden', mu, alpha: values.slice(terms), shearModulus: mu.reduce((sum, value) => sum + value, 0) };
  };
  const starts: number[][] = [];
  for (const picks of combinations(OGDEN_ALPHA_GRID.length, terms)) {
    const alpha = picks.map((index) => OGDEN_ALPHA_GRID[index] ?? 1);
    const mu = linearTerms(rows, (k) => ({ kind: 'ogden', mu: [1], alpha: [alpha[k] ?? 1], shearModulus: 1 }), terms);
    if (mu === null) continue;
    starts.push([...mu.map((value) => (positive ? Math.max(value, 1e-3 * peak) : value)), ...alpha]);
  }
  const outcome = searchFit(specs, starts, (values) => weightedResiduals(law(values), rows), control);
  return fitFailureOr(outcome, (values, report) => {
    const resolved = law(values);
    return {
      law: {
        kind: 'hyper_ogden',
        convention: 'calculix',
        terms: Array.from({ length: terms }, (_, k) => ({ mu: values[k] ?? 0, alpha: values[terms + k] ?? 1 })),
        D: new Array<number>(terms).fill(0),
        stressUnit: 'MPa',
      },
      resolved,
      ...summarising(resolved, tests, report.conditionNumber),
      convergence: report,
    };
  });
}

/**
 * Fit Arruda-Boyce (μ, λm) to nominal stress rows.
 * @failure see `searchFit`; fewer rows than parameters -> MATL_FIT_INSUFFICIENT_DATA
 */
export function fitArrudaBoyce(tests: readonly HyperTest[], objective: FitObjective, control: FitControl): NonlinearHyperFit | LawFailure {
  const rowCount = tests.reduce((sum, test) => sum + test.rows.length, 0);
  if (rowCount <= 2) return failure('MATL_FIT_INSUFFICIENT_DATA', 'tests', `${rowCount} rows for 2 parameters`, 'add data');
  const rows: Rows = { tests, objective };
  const specs: ParamSpec[] = [
    { name: 'mu', lower: 0, upper: Number.POSITIVE_INFINITY },
    { name: 'lambdaM', lower: 1.001, upper: 1000 },
  ];
  const law = (values: readonly number[]): ResolvedHyper => ({
    kind: 'invariant',
    derivatives: arrudaBoyceDerivatives(values[0] ?? 0, values[1] ?? 2),
    shearModulus: values[0] ?? 0,
  });
  const starts: number[][] = [];
  for (const lambdaM of AB_LAMBDA_GRID) {
    const mu = linearTerms(rows, () => law([1, lambdaM]), 1);
    if (mu !== null) starts.push([Math.max(mu[0] ?? 0, 1e-6), lambdaM]);
  }
  const outcome = searchFit(specs, starts, (values) => weightedResiduals(law(values), rows), control);
  return fitFailureOr(outcome, (values, report) => {
    const resolved = law(values);
    return {
      law: {
        kind: 'hyper_arruda_boyce',
        mu: { value: values[0] ?? 0, unit: 'MPa' },
        lambdaM: values[1] ?? 2,
        D: { value: 0, unit: '1/MPa' },
      },
      resolved,
      ...summarising(resolved, tests, report.conditionNumber),
      convergence: report satisfies ConvergenceReport,
    };
  });
}
