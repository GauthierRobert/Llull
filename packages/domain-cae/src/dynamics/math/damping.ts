/**
 * Damping helpers (PHY-09 §5.2, TR-DYN-10/11): Rayleigh coefficients from two target ratios and the ratio per mode actually applied
 * (CalculiX `*MODAL DAMPING`: zeta_j = alpha / (2 w_j) + beta w_j / 2; structural loss factor eta gives zeta_eq = eta / 2 at resonance).
 */

import type { DampingModel } from '@core/model/structuralDynamics';

const omega = (fHz: number): number => 2 * Math.PI * fHz;

/** alpha (1/s), beta (s) with zeta(f1) = zeta1 and zeta(f2) = zeta2; equal ratios use the closed form 2 zeta w1 w2 / (w1 + w2), 2 zeta / (w1 + w2). */
export function rayleighFromRatios(
  f1Hz: number,
  f2Hz: number,
  zeta1: number,
  zeta2: number,
): { readonly alpha: number; readonly beta: number } {
  const [w1, w2] = [omega(f1Hz), omega(f2Hz)];
  if (zeta1 === zeta2) return { alpha: (2 * zeta1 * w1 * w2) / (w1 + w2), beta: (2 * zeta1) / (w1 + w2) };
  const det = w2 * w2 - w1 * w1;
  return { alpha: (2 * w1 * w2 * (zeta1 * w2 - zeta2 * w1)) / det, beta: (2 * (zeta2 * w2 - zeta1 * w1)) / det };
}

/** Rayleigh ratio at fHz. */
export const rayleighZeta = (alpha: number, beta: number, fHz: number): number => alpha / (2 * omega(fHz)) + (beta * omega(fHz)) / 2;

/**
 * Viscous-equivalent ratio applied to mode `mode` (1-based) at `fHz`: modal ranges (last matching range wins, like repeated CalculiX lines),
 * Rayleigh, or eta / 2 for structural damping (`lossFactor`). null when the model leaves the mode undamped / unknown.
 */
export function zetaOfMode(damping: DampingModel, mode: number, fHz: number, lossFactor: number | null): number | null {
  if (damping.model === 'modal') {
    const ranges = damping.ratios.filter((range) => range.fromMode <= mode && mode <= range.toMode);
    return ranges.at(-1)?.zeta ?? null;
  }
  if (damping.model === 'structural_material') return lossFactor === null ? null : lossFactor / 2;
  return rayleighZeta(damping.alpha, damping.beta, fHz);
}

/**
 * Imaginary part of the modal dynamic stiffness D_j(w) = w_j^2 - w^2 + i (a_j + b_j w): viscous ratio zeta gives (0, 2 zeta w_j);
 * Rayleigh (alpha, beta) gives (0, alpha + beta w_j^2); structural eta gives (eta w_j^2, 0) (w_j^2 -> w_j^2 (1 + i eta)).
 */
export function dampingTerms(damping: DampingModel, mode: number, wj: number, lossFactor: number | null): { a: number; b: number } | null {
  if (damping.model === 'structural_material') return lossFactor === null ? null : { a: lossFactor * wj * wj, b: 0 };
  if (damping.model === 'modal') {
    const zeta = zetaOfMode(damping, mode, wj / (2 * Math.PI), null);
    return zeta === null ? null : { a: 0, b: 2 * zeta * wj };
  }
  return { a: 0, b: damping.alpha + damping.beta * wj * wj };
}
