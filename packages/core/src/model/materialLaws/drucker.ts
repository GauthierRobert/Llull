/**
 * Drucker stability scan of an incompressible hyperelastic law (PHY-02 §5.6, TR-MATL-08): the tangent in principal log strains is the
 * Hessian of Ŵ(ε1, ε2) = W(e^ε1, e^ε2, e^(−ε1−ε2)); the law is stable at a stretch when it is positive definite. The scan walks the grid
 * λ = 1 + 0.01 k (k = 1…900) and λ = 1 − 0.01 k (k = 1…90) in uniaxial, equibiaxial and planar modes.
 */

import type { HyperMode, ResolvedHyper } from './hyperelastic';
import { HYPER_MODES } from './hyperelastic';

interface FirstUnstable {
  readonly tension: number | null;
  readonly compression: number | null;
}

export type DruckerReport = Readonly<Record<HyperMode, FirstUnstable>>;

type Hessian = readonly [h11: number, h12: number, h22: number];

/** Hessian of Ŵ at log strains (ε1, ε2). */
function hessian(law: ResolvedHyper, e1: number, e2: number): Hessian {
  if (law.kind === 'ogden') {
    let h11 = 0;
    let h12 = 0;
    let h22 = 0;
    law.mu.forEach((mu, k) => {
      const alpha = law.alpha[k] ?? 1;
      const muP = (2 * mu) / alpha;
      const third = Math.exp(-alpha * (e1 + e2));
      h11 += muP * alpha * (Math.exp(alpha * e1) + third);
      h12 += muP * alpha * third;
      h22 += muP * alpha * (Math.exp(alpha * e2) + third);
    });
    return [h11, h12, h22];
  }
  const a = Math.exp(e1);
  const b = Math.exp(e2);
  const p = 1 / (a * a * b * b);
  const i1 = a * a + b * b + p;
  const i2 = 1 / (a * a) + 1 / (b * b) + a * a * b * b;
  const d1 = [2 * a * a - 2 * p, 2 * b * b - 2 * p] as const;
  const d2 = [-2 / (a * a) + 2 * a * a * b * b, -2 / (b * b) + 2 * a * a * b * b] as const;
  const dd1 = [4 * a * a + 4 * p, 4 * p, 4 * b * b + 4 * p] as const;
  const dd2 = [4 / (a * a) + 4 * a * a * b * b, 4 * a * a * b * b, 4 / (b * b) + 4 * a * a * b * b] as const;
  const { W1, W2, W11, W12, W22 } = law.derivatives(i1, i2);
  const entry = (k: number, p0: 0 | 1, q0: 0 | 1): number =>
    W1 * (dd1[k] ?? 0) + W2 * (dd2[k] ?? 0) + W11 * d1[p0] * d1[q0] + W12 * (d1[p0] * d2[q0] + d2[p0] * d1[q0]) + W22 * d2[p0] * d2[q0];
  return [entry(0, 0, 0), entry(1, 0, 1), entry(2, 1, 1)];
}

const logStrains = (mode: HyperMode, lambda: number): readonly [number, number] =>
  mode === 'UT'
    ? [Math.log(lambda), -0.5 * Math.log(lambda)]
    : mode === 'ET'
      ? [Math.log(lambda), Math.log(lambda)]
      : [Math.log(lambda), 0];

const stableAt = (law: ResolvedHyper, mode: HyperMode, lambda: number): boolean => {
  const [e1, e2] = logStrains(mode, lambda);
  const [h11, h12, h22] = hessian(law, e1, e2);
  return h11 > 0 && h11 * h22 - h12 * h12 > 0;
};

/** First unstable stretch per mode and side on the grid (null = stable over the whole scan). */
export function druckerScan(law: ResolvedHyper): DruckerReport {
  const report = {} as Record<HyperMode, FirstUnstable>;
  for (const mode of HYPER_MODES) {
    let tension: number | null = null;
    let compression: number | null = null;
    for (let k = 1; k <= 900 && tension === null; k += 1) {
      const lambda = 1 + 0.01 * k;
      if (!stableAt(law, mode, lambda)) tension = Math.round(lambda * 100) / 100;
    }
    for (let k = 1; k <= 90 && compression === null; k += 1) {
      const lambda = 1 - 0.01 * k;
      if (!stableAt(law, mode, lambda)) compression = Math.round(lambda * 100) / 100;
    }
    report[mode] = { tension, compression };
  }
  return report;
}
