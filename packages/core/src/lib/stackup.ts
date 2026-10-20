/**
 * Tolerance stack-up closed forms (GDT TECHNICAL_SPEC §5.7): worst case, exact corners, RSS, σ model, probabilities (normal CDF via a
 * double-precision erfc; exact CDF of a sum of uniforms), contribution percentages and Monte Carlo acceptance bounds.
 */

import { programFunction, programGradient, type Program } from './expressionProgram';

type StackDistribution = 'normal' | 'uniform';

export interface StackInput {
  readonly name: string;
  readonly nominal: number;
  /** Signed limits relative to the nominal: [nominal + lower, nominal + upper]. */
  readonly lower: number;
  readonly upper: number;
  readonly distribution: StackDistribution;
}

/** Largest contributor count for the 2^n corner enumeration (TECHNICAL_SPEC §5.7 item 2). */
const EXACT_CORNERS_MAX = 16;
/** Largest contributor count for the exact uniform-sum CDF (2^n inclusion–exclusion terms). */
const UNIFORM_CDF_MAX = 12;

export const centreOf = (c: StackInput): number => c.nominal + (c.lower + c.upper) / 2;
export const halfToleranceOf = (c: StackInput): number => (c.upper - c.lower) / 2;
/** σ_i = t_i / k (normal) or t_i / √3 (uniform). */
export const sigmaOf = (c: StackInput, sigmaPerHalfTolerance: number): number =>
  c.distribution === 'normal' ? halfToleranceOf(c) / sigmaPerHalfTolerance : halfToleranceOf(c) / Math.sqrt(3);

const SQRT_PI = Math.sqrt(Math.PI);

/** erfc(x) for x ≥ 0: positive power series below 2 (no cancellation), continued fraction above. */
function erfcPositive(x: number): number {
  if (x < 2) {
    let term = x;
    let sum = x;
    for (let n = 1; n < 200 && term >= 1e-18 * sum; n += 1) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-x * x) * sum;
  }
  let fraction = x;
  for (let k = 160; k >= 1; k -= 1) fraction = x + k / 2 / fraction;
  return Math.exp(-x * x) / SQRT_PI / fraction;
}

/** Complementary error function, relative error < 1e-12 on the tested range. */
export const erfc = (x: number): number => (x >= 0 ? erfcPositive(x) : 2 - erfcPositive(-x));

/** Standard normal CDF Φ(z) = ½ erfc(−z/√2). */
export const normalCdf = (z: number): number => 0.5 * erfc(-z / Math.SQRT2);

/**
 * P(Σ U_i ≤ x) for independent U_i uniform on [lo_i, lo_i + w_i] (generalised Irwin–Hall, inclusion–exclusion), n ≤ 12. A width below
 * 1e-6 of the largest is taken as a point mass at its centre: the alternating r^n sums would lose more digits to it (review finding) than
 * the point mass costs, which is at most (narrow width) × (density of the other terms) ≤ 1e-6 × (n-term density × largest width).
 * @failure more than 12 terms -> null
 */
export function uniformSumCdf(x: number, terms: readonly { readonly lo: number; readonly width: number }[]): number | null {
  const n = terms.length;
  if (n > UNIFORM_CDF_MAX) return null;
  const narrow = 1e-6 * Math.max(0, ...terms.map((t) => t.width));
  const widths = terms.filter((t) => t.width > narrow);
  const shift = terms.reduce((sum, t) => sum + (t.width > narrow ? t.lo : t.lo + t.width / 2), 0);
  if (widths.length === 0) return x >= shift ? 1 : 0;
  let factorial = 1;
  for (let k = 2; k <= widths.length; k += 1) factorial *= k;
  const product = widths.reduce((p, t) => p * t.width, 1);
  let total = 0;
  for (let mask = 0; mask < 1 << widths.length; mask += 1) {
    let offset = shift;
    let sign = 1;
    widths.forEach((t, i) => {
      if ((mask >> i) & 1) {
        offset += t.width;
        sign = -sign;
      }
    });
    const r = x - offset;
    if (r > 0) total += sign * Math.pow(r, widths.length);
  }
  return Math.min(1, Math.max(0, total / (factorial * product)));
}

export interface StackClosedForms {
  readonly yNominal: number;
  readonly yMean: number;
  /** ∂f/∂x_i at the means (exact: given, or forward-mode automatic differentiation). */
  readonly sensitivities: readonly number[];
  readonly worstCase: { readonly halfTolerance: number; readonly min: number; readonly max: number };
  /** min / max of f over the 2^n limit combinations; null above EXACT_CORNERS_MAX contributors. */
  readonly worstCaseExactCorners: { readonly min: number; readonly max: number } | null;
  readonly rss: { readonly halfTolerance: number; readonly min: number; readonly max: number };
  readonly sigma: number;
  readonly contributions: readonly { readonly name: string; readonly wcPercent: number; readonly rssPercent: number }[];
}

/** Closed forms of y = f(x) (`program` over the contributors in order). */
export function stackClosedForms(contributors: readonly StackInput[], program: Program, sigmaPerHalfTolerance: number): StackClosedForms {
  const f = programFunction(program);
  const centres = contributors.map(centreOf);
  const halves = contributors.map(halfToleranceOf);
  const sigmas = contributors.map((c) => sigmaOf(c, sigmaPerHalfTolerance));
  const { value: yMean, gradient } = programGradient(program, centres);
  const wcTerms = gradient.map((a, i) => Math.abs(a) * (halves[i] as number));
  const halfWc = wcTerms.reduce((sum, t) => sum + t, 0);
  const halfRss = Math.sqrt(wcTerms.reduce((sum, t) => sum + t * t, 0));
  const varianceTerms = gradient.map((a, i) => (a * (sigmas[i] as number)) ** 2);
  const variance = varianceTerms.reduce((sum, t) => sum + t, 0);
  let corners: { min: number; max: number } | null = null;
  if (contributors.length <= EXACT_CORNERS_MAX) {
    corners = { min: Infinity, max: -Infinity };
    const x = new Float64Array(contributors.length);
    for (let mask = 0; mask < 1 << contributors.length; mask += 1) {
      contributors.forEach((c, i) => {
        x[i] = c.nominal + ((mask >> i) & 1 ? c.upper : c.lower);
      });
      const y = f(x);
      corners = { min: Math.min(corners.min, y), max: Math.max(corners.max, y) };
    }
  }
  return {
    yNominal: f(contributors.map((c) => c.nominal)),
    yMean,
    sensitivities: gradient,
    worstCase: { halfTolerance: halfWc, min: yMean - halfWc, max: yMean + halfWc },
    worstCaseExactCorners: corners,
    rss: { halfTolerance: halfRss, min: yMean - halfRss, max: yMean + halfRss },
    sigma: Math.sqrt(variance),
    contributions: contributors.map((c, i) => ({
      name: c.name,
      wcPercent: halfWc === 0 ? 0 : ((wcTerms[i] as number) / halfWc) * 100,
      rssPercent: variance === 0 ? 0 : ((varianceTerms[i] as number) / variance) * 100,
    })),
  };
}

export type ProbabilityMethod = 'normal' | 'uniform_sum' | 'linearised_normal' | 'none';

/**
 * P(y < limit) of the linearised stack: exact normal CDF when every contributor is normal, exact uniform-sum CDF when every contributor is
 * uniform (n ≤ 12); `linear` false labels the normal result as a linearisation of a non-linear expression; mixed distributions -> none
 * (Monte Carlo only).
 */
export function probabilityBelow(
  limit: number,
  forms: StackClosedForms,
  contributors: readonly StackInput[],
  linear: boolean,
): { readonly p: number | null; readonly method: ProbabilityMethod } {
  if (contributors.every((c) => c.distribution === 'normal')) {
    const p = forms.sigma === 0 ? (forms.yMean < limit ? 1 : 0) : normalCdf((limit - forms.yMean) / forms.sigma);
    return { p, method: linear ? 'normal' : 'linearised_normal' };
  }
  if (linear && contributors.every((c) => c.distribution === 'uniform')) {
    const terms = contributors.map((c, i) => {
      const w = Math.abs(forms.sensitivities[i] as number) * halfToleranceOf(c);
      return { lo: -w, width: 2 * w };
    });
    const p = uniformSumCdf(limit - forms.yMean, terms);
    return p === null ? { p: null, method: 'none' } : { p, method: 'uniform_sum' };
  }
  return { p: null, method: 'none' };
}

/** 5σ statistical acceptance bounds of a Monte Carlo estimate with N samples (TECHNICAL_SPEC §5.7 item 7). */
export function monteCarloAcceptance(
  sigma: number,
  samples: number,
  p: number | null,
): { readonly meanTolerance: number; readonly stdTolerance: number; readonly pTolerance: number | null } {
  return {
    meanTolerance: (5 * sigma) / Math.sqrt(samples),
    stdTolerance: (5 * sigma) / Math.sqrt(2 * samples),
    pTolerance: p === null ? null : Math.max(5 * Math.sqrt((p * (1 - p)) / samples), 1e-5),
  };
}
