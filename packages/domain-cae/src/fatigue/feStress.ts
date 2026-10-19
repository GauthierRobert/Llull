/**
 * FE stress histories of a fatigue case (PHY-07 TR-FAT-15): linear superposition sigma(t) = sum_k s_k(t) sigma_k per node, then a scalar
 * measure per step. Only + - * / and square roots (no transcendental functions), so `llull-post` (crate `stress.rs`) reproduces every value
 * bit for bit:
 * - signed von Mises: the magnitude, signed by an invariant test (no eigenvalues);
 * - max principal: Newton on the deviatoric characteristic cubic from its upper bound (monotone); cyclic Jacobi when the two largest
 *   principal stresses nearly coincide (the cubic is ill-conditioned there);
 * - a component.
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

/** q'(s1) / J2 below which the largest root of the cubic is ill-conditioned and Jacobi decides (Newton error bound ~1e2 ulp of sqrt(J2)). */
const DEGENERATE_GAP = 1e-2;
const NEWTON_STEPS = 100;

/**
 * Largest principal stress. s1 = mean + largest root of q(t) = t^3 - J2 t - J3 (deviator), approached by Newton from 2 sqrt(J2 / 3) >= s1,
 * where q is convex and increasing, so the iterates fall monotonically; they stop when they no longer decrease. When q'(s1) = (s1 - s2)
 * (s1 - s3) is small against J2 (s1 close to s2), cyclic Jacobi gives the value instead.
 */
export function maxPrincipal(s: Tensor): number {
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = s;
  const mean = (xx + yy + zz) / 3;
  const dx = xx - mean;
  const dy = yy - mean;
  const dz = zz - mean;
  const j2 = (dx * dx + dy * dy + dz * dz) / 2 + (xy * xy + yz * yz + zx * zx);
  const j3 = dx * (dy * dz - yz * yz) - xy * (xy * dz - yz * zx) + zx * (xy * yz - dy * zx);
  let root = 2 * Math.sqrt(j2 / 3);
  for (let step = 0; step < NEWTON_STEPS; step += 1) {
    const next = root - ((root * root - j2) * root - j3) / (3 * root * root - j2);
    if (!(next < root)) break;
    root = next;
  }
  if (!(3 * root * root - j2 >= DEGENERATE_GAP * j2) || j2 === 0) return principalExtremes(s)[0];
  return mean + root;
}

/**
 * Signed von Mises: + when |s1| >= |s3| (ties +), i.e. when s1 + s3 = I1 - s2 >= 0. If |2 I1| > vM the sign of I1 decides (|s2 - I1 / 3|
 * <= sqrt(J2 / 3) = vM / 3); otherwise I1 lies in [s3, s1] and the characteristic polynomial at I1, I1 I2 - I3 = (s1 + s2)(s2 + s3)(s3 + s1),
 * is <= 0 exactly when s2 <= I1.
 */
export function signedVonMises(s: Tensor): number {
  const magnitude = vonMises(s);
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = s;
  const i1 = xx + yy + zz;
  if (magnitude === 0 || 2 * i1 > magnitude) return magnitude;
  if (2 * i1 < -magnitude) return -magnitude;
  const i2 = xx * yy + yy * zz + zz * xx - xy * xy - yz * yz - zx * zx;
  const i3 = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * zx) + zx * (xy * yz - yy * zx);
  return i1 * i2 - i3 <= 0 ? magnitude : -magnitude;
}

/** Scalar of `measure` for one tensor: signed von Mises takes the sign of the principal with the largest magnitude (ties: +). */
export function measureOf(s: Tensor, measure: MeasureSpec): number {
  if (measure.kind === 'component') return s[measure.index] ?? Number.NaN;
  return measure.kind === 'max_principal' ? maxPrincipal(s) : signedVonMises(s);
}

/** Scalar history of one node: per step, sum over load cases k (in order, from 0) of histories[k][t] x tensors[k], then the measure. */
export function nodeSeries(tensors: readonly Tensor[], histories: readonly (readonly number[])[], measure: MeasureSpec): number[] {
  const steps = histories[0]?.length ?? 0;
  const series = new Array<number>(steps);
  const tensor = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < steps; t += 1) {
    tensor.fill(0);
    for (const [k, history] of histories.entries()) {
      const h = history[t] ?? 0;
      const s = tensors[k] ?? [];
      for (let c = 0; c < 6; c += 1) tensor[c] = (tensor[c] ?? 0) + h * (s[c] ?? 0);
    }
    series[t] = measureOf(tensor, measure);
  }
  return series;
}
