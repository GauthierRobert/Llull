/**
 * Eigenvectors and participation factors of a linearised flight (13 FLT M5b): right and left eigenvectors by inverse iteration on the real
 * 2n x 2n form of (A − λI), and the participation p_k = w_k v_k / (wᵀ v) of every state in a mode (Pérez-Arriaga, Verghese & Schweppe 1982),
 * which is independent of the state units. Pure, deterministic.
 */

import { elementAt } from '@lib/elementAt';
import type { ComplexValue } from './eigenvalues';

/** Inverse-iteration sweeps (the computed eigenvalue is accurate to round-off, so two already converge; three for margin). */
const SWEEPS = 3;
/** Relative shift off the computed eigenvalue so the shifted matrix is not singular to the last bit. */
const SHIFT = 1e-10;
/** Σ|p_k| above which the mode is treated as defective (a repeated root with one eigenvector: wᵀ v → 0 and the factors are meaningless). */
const DEFECTIVE_SUM = 100;

interface ComplexVector {
  readonly re: number[];
  readonly im: number[];
}

/** Solution of the dense system `m z = rhs` by Gaussian elimination with partial pivoting; a zero pivot is replaced by `floor` (inverse iteration). */
function solveReplacingPivots(m: number[][], rhs: number[], floor: number): number[] {
  const n = rhs.length;
  const a = m.map((row) => [...row]);
  const b = [...rhs];
  const at = (i: number, j: number): number => (a[i] as number[])[j] ?? 0;
  for (let k = 0; k < n; k += 1) {
    let pivot = k;
    for (let i = k + 1; i < n; i += 1) if (Math.abs(at(i, k)) > Math.abs(at(pivot, k))) pivot = i;
    [a[k], a[pivot]] = [a[pivot] as number[], a[k] as number[]];
    [b[k], b[pivot]] = [elementAt(b, pivot), elementAt(b, k)];
    if (Math.abs(at(k, k)) < floor) (a[k] as number[])[k] = at(k, k) < 0 ? -floor : floor;
    for (let i = k + 1; i < n; i += 1) {
      const factor = at(i, k) / at(k, k);
      if (factor === 0) continue;
      for (let j = k; j < n; j += 1) (a[i] as number[])[j] = at(i, j) - factor * at(k, j);
      b[i] = elementAt(b, i) - factor * elementAt(b, k);
    }
  }
  const z = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = b[i] ?? 0;
    for (let j = i + 1; j < n; j += 1) sum -= at(i, j) * (z[j] ?? 0);
    z[i] = sum / at(i, i);
  }
  return z;
}

/** Eigenvector of `a` for the eigenvalue `value`: inverse iteration on [[A − σI, ωI], [−ωI, A − σI]] [x; y] (v = x + i y), unit 2-norm. */
function eigenvector(a: readonly (readonly number[])[], value: ComplexValue): ComplexVector {
  const n = a.length;
  const norm = Math.max(
    1,
    a.reduce(
      (most, row) =>
        Math.max(
          most,
          row.reduce((sum, entry) => sum + Math.abs(entry), 0),
        ),
      0,
    ),
  );
  const sigma = value.re + SHIFT * Math.max(1, Math.hypot(value.re, value.im));
  const omega = value.im;
  const m = Array.from({ length: 2 * n }, (_, i) =>
    Array.from({ length: 2 * n }, (_, j) => {
      const [r, c] = [i % n, j % n];
      const sameHalf = i < n === j < n;
      if (sameHalf) return (a[r]?.[c] ?? 0) - (r === c ? sigma : 0);
      if (r !== c) return 0;
      return i < n ? omega : -omega;
    }),
  );
  let z = Array.from({ length: 2 * n }, (_, k) => 1 + k / (2 * n));
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const next = solveReplacingPivots(m, z, Number.EPSILON * norm);
    const size = Math.sqrt(next.reduce((sum, entry) => sum + entry * entry, 0));
    z = next.map((entry) => entry / size);
  }
  return { re: z.slice(0, n), im: z.slice(n) };
}

interface ModeParticipation {
  /** |p_k| / Σ|p| per state (sums to 1), or null for a defective mode. */
  readonly participation: number[] | null;
  /** Share per state used for the label: the participation, else |v_k|² / |v|² of the right eigenvector (state units, so only a grouping). */
  readonly weights: number[];
  readonly basis: 'participation' | 'eigenvector';
}

/**
 * Participation of every state of `a` in the mode of eigenvalue `value`; `repeated` (another eigenvalue equals it) means the mode has no unique
 * eigenvector, so only the right-eigenvector grouping is returned.
 */
export function modeParticipation(a: readonly (readonly number[])[], value: ComplexValue, repeated: boolean): ModeParticipation {
  const right = eigenvector(a, value);
  const transposed = a.map((_, i) => a.map((row) => row[i] ?? 0));
  const left = eigenvector(transposed, value);
  const products = right.re.map((vr, k) => {
    const [vi, wr, wi] = [elementAt(right.im, k), elementAt(left.re, k), elementAt(left.im, k)];
    return { re: wr * vr - wi * vi, im: wr * vi + wi * vr };
  });
  const total = products.reduce((sum, product) => ({ re: sum.re + product.re, im: sum.im + product.im }), { re: 0, im: 0 });
  const scale = Math.hypot(total.re, total.im);
  const magnitudes = products.map((product) => Math.hypot(product.re, product.im));
  const sum = magnitudes.reduce((most, entry) => most + entry, 0);
  if (!repeated && scale > 0 && sum / scale <= DEFECTIVE_SUM) {
    const participation = magnitudes.map((entry) => entry / sum);
    return { participation, weights: participation, basis: 'participation' };
  }
  const energy = right.re.map((vr, k) => vr * vr + (right.im[k] ?? 0) ** 2);
  const all = energy.reduce((most, entry) => most + entry, 0);
  return { participation: null, weights: energy.map((entry) => entry / all), basis: 'eigenvector' };
}
