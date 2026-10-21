/** Nataf transform: standard independent normals u -> correlated normals z (Cholesky of the corrected correlation) -> marginals x. */

import type { Distribution } from '@core/model/probabilistic';
import { fromStandardNormal, momentsOf } from './distributions';
import { cholesky } from '@lib/denseLinalg';
import type { RandomVariable, ReliabilityModel } from '@core/model/probabilistic';

export interface Transform {
  readonly names: readonly string[];
  /** x for a point u of the standard normal space. */
  toX(u: readonly number[]): number[];
  /**
   * Importance factors gamma_i^2 (sum 1) of the variables for the unit vector `alpha` at the design point `u`
   * (Der Kiureghian: gamma ~ alpha^T L^-1 J_zx D, which equals alpha^2 when the variables are independent).
   */
  importance(u: readonly number[], alpha: readonly number[]): number[];
}

const GRID = 71;
const SPAN = 7;

/** Standardised X_i at the normal score z: (F^-1(Φ(z)) - mean) / sd. */
function standardised(d: Distribution, z: number): number {
  const { mean, sd } = momentsOf(d);
  return (fromStandardNormal(d, z) - mean) / sd;
}

/** E[X_i* X_j*] for standard normals with correlation rho0, by the trapezoid rule on the Gaussian-weighted grid. */
function productMoment(a: Distribution, b: Distribution, rho0: number): number {
  const step = (2 * SPAN) / (GRID - 1);
  const root = Math.sqrt(1 - rho0 * rho0);
  const weight = (t: number): number => Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI);
  let total = 0;
  for (let i = 0; i < GRID; i += 1) {
    const z1 = -SPAN + i * step;
    const left = standardised(a, z1) * weight(z1);
    let inner = 0;
    for (let k = 0; k < GRID; k += 1) {
      const w = -SPAN + k * step;
      inner += standardised(b, rho0 * z1 + root * w) * weight(w);
    }
    total += left * inner * step;
  }
  return total * step;
}

/**
 * Correlation rho0 of the underlying normals that yields correlation `rho` between the marginals a and b (Der Kiureghian-Liu), or null when
 * `rho` is not attainable for this pair of marginals.
 */
export function equivalentCorrelation(a: Distribution, b: Distribution, rho: number): number | null {
  if (rho === 0) return 0;
  if (a.kind === 'normal' && b.kind === 'normal') return rho;
  const limit = 0.999;
  let low = -limit;
  let high = limit;
  if (rho < productMoment(a, b, low) || rho > productMoment(a, b, high)) return null;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (productMoment(a, b, mid) < rho) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

const correlationOf = (model: ReliabilityModel, a: string, b: string): number => {
  const { correlation } = model;
  if (correlation === undefined) return 0;
  const i = correlation.names.indexOf(a);
  const j = correlation.names.indexOf(b);
  return i < 0 || j < 0 ? 0 : (correlation.matrix[i]?.[j] ?? 0);
};

/**
 * The transform for `variables` (in this order) under the model's correlation.
 * @failure a pair's correlation unattainable for its marginals, or the corrected matrix not positive definite -> an error string
 */
export function buildTransform(model: ReliabilityModel, variables: readonly RandomVariable[]): Transform | string {
  const n = variables.length;
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let correlated = false;
  for (let i = 0; i < n; i += 1) {
    (matrix[i] as number[])[i] = 1;
    for (let j = 0; j < i; j += 1) {
      const a = variables[i] as RandomVariable;
      const b = variables[j] as RandomVariable;
      const rho = correlationOf(model, a.name, b.name);
      if (rho === 0) continue;
      const rho0 = equivalentCorrelation(a.distribution, b.distribution, rho);
      if (rho0 === null) return `correlation ${rho} between '${a.name}' and '${b.name}' is not attainable for their distributions`;
      (matrix[i] as number[])[j] = rho0;
      (matrix[j] as number[])[i] = rho0;
      correlated = true;
    }
  }
  const lower = correlated ? cholesky(matrix) : null;
  if (correlated && lower === null) return 'the correlation matrix, corrected for the non-normal marginals, is not positive definite';
  const toX = (u: readonly number[]): number[] =>
    variables.map((variable, i) => {
      const row = lower?.[i];
      const z = row === undefined ? (u[i] ?? 0) : row.reduce((sum, coefficient, k) => sum + coefficient * (u[k] ?? 0), 0);
      return fromStandardNormal(variable.distribution, z);
    });
  const importance = (u: readonly number[], alpha: readonly number[]): number[] => {
    // v = L^-T alpha by back substitution of L^T v = alpha
    const v = [...alpha];
    if (lower !== null)
      for (let i = n - 1; i >= 0; i -= 1) {
        let sum = alpha[i] ?? 0;
        for (let k = i + 1; k < n; k += 1) sum -= (lower[k]?.[i] ?? 0) * (v[k] ?? 0);
        v[i] = sum / (lower[i]?.[i] ?? 1);
      }
    const z = variables.map((_, i) =>
      lower?.[i] === undefined ? (u[i] ?? 0) : (lower[i]?.reduce((s, c, k) => s + c * (u[k] ?? 0), 0) ?? 0),
    );
    const gamma = variables.map((variable, i) => {
      const h = 1e-5;
      const dxdz =
        (fromStandardNormal(variable.distribution, (z[i] ?? 0) + h) - fromStandardNormal(variable.distribution, (z[i] ?? 0) - h)) / (2 * h);
      return ((v[i] ?? 0) * momentsOf(variable.distribution).sd) / dxdz;
    });
    const total = gamma.reduce((s, g) => s + g * g, 0);
    return gamma.map((g) => (total > 0 ? (g * g) / total : 0));
  };
  return { names: variables.map((variable) => variable.name), toX, importance };
}
