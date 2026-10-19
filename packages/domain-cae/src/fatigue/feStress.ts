/**
 * FE stress histories of a fatigue case (PHY-07 TR-FAT-15): linear superposition sigma(t) = sum_k s_k(t) sigma_k per node, then a scalar
 * measure per step. Principal stresses use cyclic Jacobi rotations (square roots only), so `llull-post` (crate `stress.rs`) reproduces
 * every value bit for bit.
 */

import type { FatigueCase } from '@core/model/durability';
import { vonMises } from '../results/fields';

/** `[Sxx, Syy, Szz, Sxy, Syz, Szx]`, MPa. */
export type Tensor = readonly number[];

const STRESS_COMPONENTS = ['sxx', 'syy', 'szz', 'sxy', 'syz', 'szx'] as const;

/** Wire form of the measure (`llull-post` `Measure`). */
export type MeasureSpec =
  | { readonly kind: 'signed_von_mises' }
  | { readonly kind: 'max_principal' }
  | { readonly kind: 'component'; readonly index: number };

export function measureSpecOf(measure: FatigueCase['measure']): MeasureSpec {
  if (typeof measure === 'string') return { kind: measure };
  return { kind: 'component', index: STRESS_COMPONENTS.indexOf(measure.component) };
}

const SWEEPS = 60;
const PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

/** Largest and smallest principal stress of a tensor (cyclic Jacobi; values only; stops when the off-diagonal norm is 1e-16 of the tensor norm). */
export function principalExtremes(s: Tensor): readonly [number, number] {
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = s;
  const a = [
    [xx, xy, zx],
    [xy, yy, yz],
    [zx, yz, zz],
  ];
  const at = (i: number, j: number): number => a[i]?.[j] ?? 0;
  const set = (i: number, j: number, value: number): void => void ((a[i] as number[])[j] = value);
  const scaleSquared = xx * xx + yy * yy + zz * zz + xy * xy + zx * zx + yz * yz;
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const [a01, a02, a12] = [at(0, 1), at(0, 2), at(1, 2)];
    if (a01 * a01 + a02 * a02 + a12 * a12 <= 1e-32 * scaleSquared) break;
    for (const [p, q] of PAIRS) {
      const apq = at(p, q);
      if (apq === 0) continue;
      const theta = (at(q, q) - at(p, p)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const sn = t * c;
      for (let k = 0; k < 3; k += 1) {
        const [akp, akq] = [at(k, p), at(k, q)];
        set(k, p, c * akp - sn * akq);
        set(k, q, sn * akp + c * akq);
      }
      for (let k = 0; k < 3; k += 1) {
        const [apk, aqk] = [at(p, k), at(q, k)];
        set(p, k, c * apk - sn * aqk);
        set(q, k, sn * apk + c * aqk);
      }
    }
  }
  const values = [at(0, 0), at(1, 1), at(2, 2)];
  let [high, low] = [values[0] ?? 0, values[0] ?? 0];
  for (const value of values.slice(1)) {
    if (value > high) high = value;
    if (value < low) low = value;
  }
  return [high, low];
}

/** Scalar of `measure` for one tensor: signed von Mises takes the sign of the principal with the largest magnitude (ties: +). */
export function measureOf(s: Tensor, measure: MeasureSpec): number {
  if (measure.kind === 'component') return s[measure.index] ?? Number.NaN;
  const [high, low] = principalExtremes(s);
  if (measure.kind === 'max_principal') return high;
  const magnitude = vonMises(s);
  return Math.abs(high) >= Math.abs(low) ? magnitude : -magnitude;
}

/** Scalar history of one node: per step, sum over load cases k (in order, from 0) of histories[k][t] x tensors[k], then the measure. */
export function nodeSeries(tensors: readonly Tensor[], histories: readonly (readonly number[])[], measure: MeasureSpec): number[] {
  const steps = histories[0]?.length ?? 0;
  const series: number[] = [];
  for (let t = 0; t < steps; t += 1) {
    const tensor = [0, 0, 0, 0, 0, 0];
    for (const [k, history] of histories.entries()) {
      const h = history[t] ?? 0;
      const s = tensors[k] ?? [];
      for (let c = 0; c < 6; c += 1) tensor[c] = (tensor[c] ?? 0) + h * (s[c] ?? 0);
    }
    series.push(measureOf(tensor, measure));
  }
  return series;
}
