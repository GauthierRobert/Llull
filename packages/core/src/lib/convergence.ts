/**
 * Grid-convergence arithmetic (Celik et al. 2008 procedure; Roache GCI): observed order, Richardson extrapolation, GCI, asymptotic
 * ratio, classification, required and representative spacing. Pure, IEEE double; samples are given finest-first (h1 < h2 < h3).
 */

export interface ConvergenceSample {
  readonly h: number;
  readonly value: number;
}

export type ConvergenceStatus = 'monotone' | 'oscillatory' | 'divergent' | 'converged_exactly' | 'two_level' | 'order_pair' | 'no_fit';

export interface TripletReport {
  readonly levels: readonly [number, number, number];
  readonly r21: number;
  readonly r32: number;
  readonly status: ConvergenceStatus;
  readonly ratio: number;
  readonly p?: number;
  readonly iterations?: number;
  readonly extrapolated?: number;
  readonly ea21?: number;
  readonly eext21?: number;
  readonly gci21Fine?: number;
  readonly gci21Coarse?: number;
  readonly gci32Fine?: number;
  readonly asymptoticRatio?: number;
  readonly gciAbs?: number;
  readonly relativeUndefined?: true;
}

const ORDER_STOP = 1e-14;
const ORDER_MAX_ITERATIONS = 10_000;

/** Classify by R = e32 / e21 (e21 = f2 − f1, e32 = f3 − f2). */
export function classify(f1: number, f2: number, f3: number): { readonly status: ConvergenceStatus; readonly ratio: number } {
  const e21 = f2 - f1;
  const e32 = f3 - f2;
  if (e21 === 0 || e32 === 0) return { status: 'converged_exactly', ratio: e21 === 0 ? Number.POSITIVE_INFINITY : 0 };
  const ratio = e32 / e21;
  if (ratio < 0) return { status: 'oscillatory', ratio };
  if (Math.abs(ratio) <= 1) return { status: 'divergent', ratio };
  return { status: 'monotone', ratio };
}

/**
 * Observed order of a monotone triplet: closed form for a constant ratio, else the fixed-point iteration with relaxation ½
 * (p ← ½p + ½|ln|R| + q(p)| / ln r21, q(p) = ln((r21^p − s)/(r32^p − s))).
 * @failure no convergence within 10 000 iterations -> `{ converged: false }`
 */
export function observedOrder(
  r21: number,
  r32: number,
  ratio: number,
): { readonly converged: true; readonly p: number; readonly iterations: number } | { readonly converged: false } {
  const lnR = Math.log(Math.abs(ratio));
  if (r21 === r32) return { converged: true, p: Math.abs(lnR) / Math.log(r21), iterations: 0 };
  const s = Math.sign(ratio);
  let p = Math.abs(lnR) / Math.log(r21);
  for (let iteration = 1; iteration <= ORDER_MAX_ITERATIONS; iteration += 1) {
    const q = Math.log((r21 ** p - s) / (r32 ** p - s));
    const next = 0.5 * p + (0.5 * Math.abs(lnR + q)) / Math.log(r21);
    if (!Number.isFinite(next)) return { converged: false };
    if (Math.abs(next - p) < ORDER_STOP) return { converged: true, p: next, iterations: iteration };
    p = next;
  }
  return { converged: false };
}

interface Extrapolation {
  readonly extrapolated: number;
  readonly ea21?: number;
  readonly eext21?: number;
  readonly gci21Fine?: number;
  readonly gci21Coarse?: number;
  readonly gciAbs?: number;
  readonly relativeUndefined?: true;
}

/** Richardson extrapolation and the fine/coarse GCI of the pair (f1 fine, f2 coarse) at order p and ratio r. */
export function richardson(f1: number, f2: number, r: number, p: number, fs: number): Extrapolation {
  const rp = r ** p;
  const extrapolated = (rp * f1 - f2) / (rp - 1);
  if (f1 === 0) return { extrapolated, gciAbs: (fs * Math.abs(f1 - f2)) / (rp - 1), relativeUndefined: true };
  const ea21 = Math.abs((f1 - f2) / f1);
  const gci21Fine = (fs * ea21) / (rp - 1);
  return {
    extrapolated,
    ea21,
    ...(extrapolated !== 0 ? { eext21: Math.abs((extrapolated - f1) / extrapolated) } : {}),
    gci21Fine,
    gci21Coarse: gci21Fine * rp,
  };
}

/** Full GCI report of one finest-first triplet; only `monotone` carries p, extrapolation and GCI. */
export function gciTriplet(
  samples: readonly [ConvergenceSample, ConvergenceSample, ConvergenceSample],
  fs: number,
  levels: readonly [number, number, number] = [0, 1, 2],
): TripletReport | { readonly orderNotConverged: true; readonly levels: readonly [number, number, number] } {
  const [s1, s2, s3] = samples;
  const r21 = s2.h / s1.h;
  const r32 = s3.h / s2.h;
  const { status, ratio } = classify(s1.value, s2.value, s3.value);
  const base = { levels, r21, r32, status, ratio };
  if (status !== 'monotone') return base;
  const order = observedOrder(r21, r32, ratio);
  if (!order.converged) return { orderNotConverged: true, levels };
  const { p, iterations } = order;
  const pair = richardson(s1.value, s2.value, r21, p, fs);
  const gci32Fine = s2.value === 0 ? undefined : (fs * Math.abs((s2.value - s3.value) / s2.value)) / (r32 ** p - 1);
  const asymptoticRatio =
    pair.gci21Fine !== undefined && gci32Fine !== undefined && gci32Fine !== 0 ? (r21 ** p * pair.gci21Fine) / gci32Fine : undefined;
  return {
    ...base,
    p,
    iterations,
    ...pair,
    ...(gci32Fine !== undefined ? { gci32Fine } : {}),
    ...(asymptoticRatio !== undefined ? { asymptoticRatio } : {}),
  };
}

/** Spacing h* = h1 / (GCI21 / GCI*)^(1/p) that would reach the target GCI* (corrected NPARC form). */
export function requiredSpacing(gciTarget: number, gci21: number, p: number, h1: number): number {
  return h1 / (gci21 / gciTarget) ** (1 / p);
}

/** Representative spacing h = (measure / elements)^(1/dimension) of an unstructured mesh. */
export function representativeSpacing(measure: number, elements: number, dimension: 1 | 2 | 3): number {
  return (measure / elements) ** (1 / dimension);
}

/** Search range of the fitted order: the lower bound excludes a vanishing order (a plateau), the upper one a numerically meaningless fit. */
const LSQ_P_MIN = 0.05;
const LSQ_P_MAX = 8;
const LSQ_P_GRID_STEP = 0.05;
const LSQ_GOLDEN_ITERATIONS = 80;
const LSQ_NEWTON_ITERATIONS = 100;

export interface LeastSquaresFit {
  readonly converged: true;
  /** Fitted order of f = f0 + alpha h^p. */
  readonly p: number;
  /** Fitted value at h = 0 (the extrapolated value). */
  readonly f0: number;
  readonly alpha: number;
  /** Weighted sum of squared residuals. */
  readonly rss: number;
  /** sqrt(sum r^2 / n) of the plain residuals r = f - fit, in the unit of f. */
  readonly residualRms: number;
  /** sqrt(sum r^2 / (n - 3)): the standard deviation of the fit (3 fitted parameters), in the unit of f. */
  readonly standardDeviation: number;
  readonly degreesOfFreedom: number;
  /** Asymptotic standard errors from s^2 (J^T W J)^-1 at the optimum; absent when that matrix is singular. */
  readonly standardError?: { readonly p: number; readonly f0: number; readonly alpha: number };
  readonly iterations: number;
}

export type LeastSquaresResult = LeastSquaresFit | { readonly converged: false; readonly reason: string };

interface LinearFit {
  readonly f0: number;
  readonly alpha: number;
  readonly rss: number;
}

const at = (values: readonly number[], index: number): number => values[index] as number;

/** Weighted straight-line fit of f against x = h^p (centred form: no cancellation when the x are close). */
function linearFit(h: readonly number[], f: readonly number[], w: readonly number[], p: number): LinearFit {
  let sw = 0;
  let sx = 0;
  let sf = 0;
  h.forEach((hi, i) => {
    sw += at(w, i);
    sx += at(w, i) * hi ** p;
    sf += at(w, i) * at(f, i);
  });
  const xMean = sx / sw;
  const fMean = sf / sw;
  let sxx = 0;
  let sxf = 0;
  h.forEach((hi, i) => {
    const dx = hi ** p - xMean;
    sxx += at(w, i) * dx * dx;
    sxf += at(w, i) * dx * (at(f, i) - fMean);
  });
  const alpha = sxf / sxx;
  const f0 = fMean - alpha * xMean;
  let rss = 0;
  h.forEach((hi, i) => {
    const r = at(f, i) - f0 - alpha * hi ** p;
    rss += at(w, i) * r * r;
  });
  return { f0, alpha, rss };
}

/** Solve the 3 x 3 system `a x = b` by Gaussian elimination with partial pivoting; null when singular. */
function solve3(a: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const m = a.map((row, i) => [...row, at(b, i)]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1)
      if (Math.abs(at(m[row] as number[], col)) > Math.abs(at(m[pivot] as number[], col))) pivot = row;
    const top = m[pivot] as number[];
    if (!(Math.abs(at(top, col)) > 1e-300)) return null;
    m[pivot] = m[col] as number[];
    m[col] = top;
    for (let row = col + 1; row < 3; row += 1) {
      const line = m[row] as number[];
      const factor = at(line, col) / at(top, col);
      for (let k = col; k < 4; k += 1) line[k] = at(line, k) - factor * at(top, k);
    }
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    const line = m[row] as number[];
    let sum = at(line, 3);
    for (let k = row + 1; k < 3; k += 1) sum -= at(line, k) * at(x, k);
    x[row] = sum / at(line, row);
  }
  return x.every(Number.isFinite) ? x : null;
}

interface Parameters3 {
  readonly f0: number;
  readonly alpha: number;
  readonly p: number;
}

/** J^T W J, J^T W r and the weighted residual sum of f - f0 - alpha h^p at `parameters`, for the Gauss-Newton step and the covariance. */
function normalEquations(
  h: readonly number[],
  f: readonly number[],
  w: readonly number[],
  parameters: Parameters3,
): { readonly jtj: number[][]; readonly jtr: number[]; readonly rss: number } {
  const jtj = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const jtr = [0, 0, 0];
  let rss = 0;
  h.forEach((hi, i) => {
    const wi = at(w, i);
    const x = hi ** parameters.p;
    const r = at(f, i) - parameters.f0 - parameters.alpha * x;
    const j = [-1, -x, -parameters.alpha * x * Math.log(hi)];
    rss += wi * r * r;
    for (let a = 0; a < 3; a += 1) {
      jtr[a] = at(jtr, a) + wi * at(j, a) * r;
      const row = jtj[a] as number[];
      for (let b = 0; b < 3; b += 1) row[b] = at(row, b) + wi * at(j, a) * at(j, b);
    }
  });
  return { jtj, jtr, rss };
}

/** Minimise `objective` over [lo, hi] by golden-section search (the objective is the variable-projection residual: f0 and alpha are solved for each p). */
function goldenMinimum(objective: (p: number) => number, lo: number, hi: number): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = objective(c);
  let fd = objective(d);
  for (let iteration = 0; iteration < LSQ_GOLDEN_ITERATIONS; iteration += 1) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = objective(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = objective(d);
    }
  }
  return (a + b) / 2;
}

/** Gauss-Newton polish of all three parameters from `start` (backtracking; exact data converge quadratically to rounding). */
function polish(
  h: readonly number[],
  f: readonly number[],
  w: readonly number[],
  start: Parameters3,
): { readonly parameters: Parameters3; readonly iterations: number } {
  let current = start;
  let iterations = 0;
  for (; iterations < LSQ_NEWTON_ITERATIONS; iterations += 1) {
    const { jtj, jtr, rss } = normalEquations(h, f, w, current);
    if (rss === 0) break;
    const step = solve3(
      jtj,
      jtr.map((value) => -value),
    );
    if (step === null) break;
    let scale = 1;
    let accepted = false;
    for (let halving = 0; halving < 30 && !accepted; halving += 1) {
      const next = { f0: current.f0 + scale * at(step, 0), alpha: current.alpha + scale * at(step, 1), p: current.p + scale * at(step, 2) };
      if (next.p > LSQ_P_MIN && next.p < LSQ_P_MAX && normalEquations(h, f, w, next).rss <= rss) {
        current = next;
        accepted = true;
      } else scale /= 2;
    }
    if (!accepted || Math.abs(scale * at(step, 2)) < 1e-15 * Math.max(1, Math.abs(current.p))) break;
  }
  return { parameters: current, iterations };
}

/**
 * Least-squares fit of f = f0 + alpha h^p to 4 or more samples (the model of Eca & Hoekstra 2014, JCP 262, for noisy refinement studies): for each p
 * the linear parameters follow from a weighted straight-line fit, p minimises the residual over [0.05, 8] (grid, golden section), and a
 * Gauss-Newton polish on all three parameters restores full precision (exact data are recovered to rounding). Weights default to 1.
 * @invariant pure, IEEE double; a data set of the exact law gives rss ~0 and p to ~1e-12
 * @failure fewer than 4 samples, non-positive h, non-finite values, bad weights -> `{ converged: false }`; the minimum on the search boundary
 *   (no finite order in range: a plateau or divergence) -> `{ converged: false }`
 */
export function leastSquaresOrder(samples: readonly ConvergenceSample[], weights?: readonly number[]): LeastSquaresResult {
  const n = samples.length;
  if (n < 4) return { converged: false, reason: 'at least 4 samples are needed' };
  const h = samples.map((sample) => sample.h);
  const f = samples.map((sample) => sample.value);
  if (!h.every((value) => Number.isFinite(value) && value > 0) || !f.every(Number.isFinite))
    return { converged: false, reason: 'spacings must be finite and positive, values finite' };
  const w = weights ?? h.map(() => 1);
  if (w.length !== n || !w.every((value) => Number.isFinite(value) && value > 0))
    return { converged: false, reason: 'weights must be one positive finite number per sample' };
  const rssAt = (p: number): number => linearFit(h, f, w, p).rss;
  let best = LSQ_P_MIN;
  let bestRss = rssAt(LSQ_P_MIN);
  const steps = Math.round((LSQ_P_MAX - LSQ_P_MIN) / LSQ_P_GRID_STEP);
  for (let k = 1; k <= steps; k += 1) {
    const p = LSQ_P_MIN + k * LSQ_P_GRID_STEP;
    const value = rssAt(p);
    if (value < bestRss) {
      best = p;
      bestRss = value;
    }
  }
  if (best <= LSQ_P_MIN || best >= LSQ_P_MAX - LSQ_P_GRID_STEP / 2)
    return { converged: false, reason: `no order in [${LSQ_P_MIN}, ${LSQ_P_MAX}] fits the samples (the best fit sits on the boundary)` };
  const p0 = goldenMinimum(rssAt, best - LSQ_P_GRID_STEP, best + LSQ_P_GRID_STEP);
  const { f0: f00, alpha: alpha0 } = linearFit(h, f, w, p0);
  const { parameters, iterations } = polish(h, f, w, { f0: f00, alpha: alpha0, p: p0 });
  const { f0, alpha, p } = parameters;
  const final = normalEquations(h, f, w, parameters);
  let plainSquares = 0;
  h.forEach((hi, i) => {
    const r = at(f, i) - f0 - alpha * hi ** p;
    plainSquares += r * r;
  });
  const degreesOfFreedom = n - 3;
  const weightedVariance = final.rss / degreesOfFreedom;
  const diagonal = [0, 1, 2].map((index) => {
    const column = solve3(
      final.jtj,
      [0, 1, 2].map((row) => (row === index ? 1 : 0)),
    );
    return column === null ? Number.NaN : at(column, index) * weightedVariance;
  });
  const standardError = diagonal.every((value) => Number.isFinite(value) && value >= 0)
    ? { f0: Math.sqrt(at(diagonal, 0)), alpha: Math.sqrt(at(diagonal, 1)), p: Math.sqrt(at(diagonal, 2)) }
    : undefined;
  return {
    converged: true,
    p,
    f0,
    alpha,
    rss: final.rss,
    residualRms: Math.sqrt(plainSquares / n),
    standardDeviation: Math.sqrt(plainSquares / degreesOfFreedom),
    degreesOfFreedom,
    ...(standardError !== undefined ? { standardError } : {}),
    iterations,
  };
}

/**
 * Uncertainty of the finest sample from a least-squares fit (llull implementation choice, NOT confirmed against Eca & Hoekstra 2014): `fs` times the extrapolation distance |f1 - f0| plus the standard
 * deviation of the fit (the weighting of the published procedure is reviewer-confirmable, TECHNICAL_SPEC 11).
 * @invariant absolute, in the unit of f; `relative` (a fraction of |f1|) is absent when f1 = 0
 */
export function leastSquaresUncertainty(
  fit: LeastSquaresFit,
  finest: ConvergenceSample,
  fs: number,
): { readonly absolute: number; readonly relative?: number } {
  const absolute = fs * Math.abs(finest.value - fit.f0) + fit.standardDeviation;
  return { absolute, ...(finest.value !== 0 ? { relative: absolute / Math.abs(finest.value) } : {}) };
}
