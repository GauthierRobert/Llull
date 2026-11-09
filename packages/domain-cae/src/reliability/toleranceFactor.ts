/** One-sided tolerance factors (basis values): normal by the exact non-central t quantile, distribution-free by order statistics. Pure. */

import { normalCdf } from '@lib/specialFunctions';
import { normalInv } from './numerics';

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(z) for z >= 0.5 (Lanczos g = 7; stays finite for large z). */
function lnGamma(z: number): number {
  const x = z - 1;
  const a = LANCZOS.slice(1).reduce((sum, c, i) => sum + c / (x + i + 1), LANCZOS[0] ?? 0);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const PANELS = 8000;

/**
 * P(T <= t) of the non-central t distribution with `nu` degrees of freedom and non-centrality `delta`:
 * the integral of Φ(t u / sqrt(nu) - delta) against the chi density of u = sqrt(V), V ~ chi²(nu) (Simpson, 8000 panels).
 */
export function noncentralTCdf(t: number, nu: number, delta: number): number {
  const spread = 14 * Math.sqrt(2 * nu);
  const low = Math.sqrt(Math.max(0, nu - spread));
  const high = Math.sqrt(nu + spread + 20);
  const width = (high - low) / PANELS;
  const logConstant = -(nu / 2) * Math.LN2 - lnGamma(nu / 2);
  const chiDensity = (u: number): number => {
    if (u === 0) return nu === 1 ? 2 * Math.exp(logConstant) : 0;
    return 2 * Math.exp(logConstant + (nu - 1) * Math.log(u) - (u * u) / 2);
  };
  const integrand = (u: number): number => normalCdf((t * u) / Math.sqrt(nu) - delta) * chiDensity(u);
  let sum = integrand(low) + integrand(high);
  for (let i = 1; i < PANELS; i += 1) sum += integrand(low + i * width) * (i % 2 === 1 ? 4 : 2);
  return Math.min(1, Math.max(0, (sum * width) / 3));
}

/**
 * k with x_bar - k s the lower `confidence` bound of the (1 - coverage) quantile of a normal population: k = t'_conf(n - 1, z_coverage sqrt(n)) / sqrt(n).
 * @invariant matches the published one-sided factors (n = 10: 2.355 B-basis, 3.981 A-basis); k -> z_coverage as n -> infinity
 * @failure n < 2 or coverage / confidence outside (0, 1) -> NaN
 */
export function normalToleranceFactor(n: number, coverage: number, confidence: number): number {
  if (!(n >= 2 && coverage > 0 && coverage < 1 && confidence > 0 && confidence < 1)) return Number.NaN;
  const delta = normalInv(coverage) * Math.sqrt(n);
  let low = 0;
  let high = 80 * Math.sqrt(n);
  for (let i = 0; i < 80; i += 1) {
    const middle = (low + high) / 2;
    if (noncentralTCdf(middle, n - 1, delta) < confidence) low = middle;
    else high = middle;
  }
  return (low + high) / 2 / Math.sqrt(n);
}

export interface NonparametricBasis {
  /** 1-based rank of the order statistic (1 = lowest value) that is the basis value; 0 when n is too small. */
  readonly rank: number;
  /** Smallest n for which the lowest value is a valid basis value: ceil(ln(1 - confidence) / ln(coverage)). */
  readonly minimumN: number;
}

/**
 * Distribution-free basis value: the r-th lowest of n values is a lower `confidence` bound of the (1 - coverage) quantile when
 * P(Binomial(n, 1 - coverage) >= r) >= confidence; the largest such r.
 * @invariant minimumN = 299 for A-basis (0.99, 0.95) and 29 for B-basis (0.90, 0.95)
 */
export function nonparametricBasis(n: number, coverage: number, confidence: number): NonparametricBasis {
  const q = 1 - coverage;
  let cumulative = 0;
  let rank = 0;
  let pmf = Math.pow(1 - q, n);
  for (let r = 1; r <= n; r += 1) {
    cumulative += pmf;
    if (cumulative > 1 - confidence) break;
    rank = r;
    pmf *= ((n - r + 1) / r) * (q / (1 - q));
  }
  return { rank, minimumN: Math.ceil(Math.log(1 - confidence) / Math.log(coverage)) };
}
