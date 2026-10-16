/**
 * Grid-convergence arithmetic (Celik et al. 2008 procedure; Roache GCI): observed order, Richardson extrapolation, GCI, asymptotic
 * ratio, classification, required and representative spacing. Pure, IEEE double; samples are given finest-first (h1 < h2 < h3).
 */

export interface ConvergenceSample {
  readonly h: number;
  readonly value: number;
}

export type ConvergenceStatus = 'monotone' | 'oscillatory' | 'divergent' | 'converged_exactly' | 'two_level';

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
