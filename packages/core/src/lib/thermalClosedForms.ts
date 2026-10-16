/** Closed-form heat-transfer solutions in SI scalars (PHY-03 TR-THM-40): the formulas of docs/physics/03-thermal-analysis/validation/generate_thermal_reference.py. */

const H_PLANCK = 6.62607015e-34;
const K_BOLTZMANN = 1.380649e-23;
const C_LIGHT = 299792458;

/** Stefan-Boltzmann constant in W/(m^2 K^4) from the exact 2019 SI defining constants. */
export const STEFAN_BOLTZMANN: number = (2 * Math.PI ** 5 * K_BOLTZMANN ** 4) / (15 * H_PLANCK ** 3 * C_LIGHT ** 2);

/** Error function by the all-positive series erf(x) = 2/sqrt(pi) e^(-x^2) sum x^(2n+1) 2^n / (2n+1)!!; |x| >= 6 returns ±1. */
function erf(x: number): number {
  if (x === 0 || Number.isNaN(x)) return x;
  const a = Math.abs(x);
  if (a >= 6) return Math.sign(x);
  let term = a;
  let sum = a;
  for (let n = 1; n < 1000 && term > sum * 1e-17; n += 1) {
    term *= (2 * a * a) / (2 * n + 1);
    sum += term;
  }
  const value = (2 / Math.sqrt(Math.PI)) * Math.exp(-a * a) * sum;
  return x < 0 ? -value : value;
}

export interface WallResult {
  readonly flux: number;
  readonly surface1: number;
  readonly surface2: number;
  readonly resistance: number;
  readonly balanceResidual: number;
}

/** Plane wall with convection on both faces: q = (T1 - T2) / (1/h1 + L/k + 1/h2). */
export function planeWall(length: number, k: number, h1: number, t1: number, h2: number, t2: number): WallResult {
  const resistance = 1 / h1 + length / k + 1 / h2;
  const flux = (t1 - t2) / resistance;
  const surface1 = t1 - flux / h1;
  const surface2 = t2 + flux / h2;
  const entering = h1 * (t1 - surface1);
  const leaving = h2 * (surface2 - t2);
  return { flux, surface1, surface2, resistance, balanceResidual: entering === 0 ? 0 : Math.abs(entering - leaving) / Math.abs(entering) };
}

/** Slab with uniform generation, both faces at Ts: centre temperature Ts + q''' L^2 / (2 k), L = half thickness. */
export const slabGenerationRise = (halfThickness: number, k: number, generation: number): number =>
  (generation * halfThickness * halfThickness) / (2 * k);

/** Semi-infinite solid after a surface step: T = Ts + (Ti - Ts) erf(x / (2 sqrt(alpha t))). */
export const semiInfinite = (initial: number, surface: number, alpha: number, x: number, t: number): number =>
  surface + (initial - surface) * erf(x / (2 * Math.sqrt(alpha * t)));

export interface LumpedResult {
  readonly temperature: number;
  readonly biot: number;
  readonly timeConstant: number;
}

/** Lumped-capacitance sphere: V/A = d/6, Bi = h V/A / k, tau = rho c V/A / h. */
export function lumpedSphere(
  d: number,
  rho: number,
  c: number,
  k: number,
  h: number,
  initial: number,
  ambient: number,
  t: number,
): LumpedResult {
  const volumeOverArea = d / 6;
  const timeConstant = (rho * c * volumeOverArea) / h;
  return { temperature: ambient + (initial - ambient) * Math.exp(-t / timeConstant), biot: (h * volumeOverArea) / k, timeConstant };
}

/** Straight pin fin with adiabatic tip: m = sqrt(4h/(k d)), eta = tanh(mL)/(mL). */
export function pinFin(h: number, k: number, d: number, length: number): { readonly efficiency: number; readonly m: number } {
  const m = Math.sqrt((4 * h) / (k * d));
  return { efficiency: Math.tanh(m * length) / (m * length), m };
}

/** Infinite grey parallel plates: q = sigma (T1^4 - T2^4) / (1/e1 + 1/e2 - 1), absolute temperatures. */
export const parallelPlates = (t1: number, t2: number, e1: number, e2: number): number =>
  (STEFAN_BOLTZMANN * (t1 ** 4 - t2 ** 4)) / (1 / e1 + 1 / e2 - 1);

/** Two slabs in series with an interface conductance hc: q = dT / (L1/k1 + 1/hc + L2/k2). */
export function interfaceSlabs(
  l1: number,
  k1: number,
  hc: number,
  l2: number,
  k2: number,
  hot: number,
  cold: number,
): { readonly flux: number; readonly jump: number; readonly resistance: number } {
  const resistance = l1 / k1 + 1 / hc + l2 / k2;
  const flux = (hot - cold) / resistance;
  return { flux, jump: flux / hc, resistance };
}

/** One-phase Neumann melting: root of lam e^(lam^2) erf(lam) = Ste / sqrt(pi) by 200 bisections on [1e-9, 3]; null when the root is not bracketed. */
export function neumannMelting(
  k: number,
  rho: number,
  cp: number,
  latent: number,
  deltaT: number,
  t: number,
): { readonly lambda: number; readonly front: number; readonly stefanNumber: number } | null {
  const stefanNumber = (cp * deltaT) / latent;
  const residual = (z: number): number => z * Math.exp(z * z) * erf(z) - stefanNumber / Math.sqrt(Math.PI);
  let [lo, hi] = [1e-9, 3];
  const lowSign = residual(lo) > 0;
  if (lowSign === residual(hi) > 0) return null;
  for (let step = 0; step < 200; step += 1) {
    const mid = 0.5 * (lo + hi);
    if (residual(mid) > 0 === lowSign) lo = mid;
    else hi = mid;
  }
  const lambda = 0.5 * (lo + hi);
  return { lambda, front: 2 * lambda * Math.sqrt((k / (rho * cp)) * t), stefanNumber };
}

/** View factor of identical-orientation parallel rectangles a x b at spacing c (Howell C-11). */
export function viewFactorParallel(a: number, b: number, c: number): number {
  const x = a / c;
  const y = b / c;
  let sum = 0.5 * Math.log(((1 + x * x) * (1 + y * y)) / (1 + x * x + y * y));
  sum += x * Math.sqrt(1 + y * y) * Math.atan(x / Math.sqrt(1 + y * y));
  sum += y * Math.sqrt(1 + x * x) * Math.atan(y / Math.sqrt(1 + x * x));
  sum -= x * Math.atan(x) + y * Math.atan(y);
  return (2 / (Math.PI * x * y)) * sum;
}

/** View factor from rectangle 1 (width w) to rectangle 2 (height h) sharing an edge of length l at 90 degrees (Hottel). */
export function viewFactorPerpendicular(l: number, w: number, h: number): number {
  const bigW = w / l;
  const bigH = h / l;
  const r = Math.sqrt(bigH * bigH + bigW * bigW);
  const a = bigW * Math.atan(1 / bigW) + bigH * Math.atan(1 / bigH) - r * Math.atan(1 / r);
  const g1 = ((1 + bigW * bigW) * (1 + bigH * bigH)) / (1 + bigW * bigW + bigH * bigH);
  const g2 = ((bigW * bigW * (1 + bigW * bigW + bigH * bigH)) / ((1 + bigW * bigW) * (bigW * bigW + bigH * bigH))) ** (bigW * bigW);
  const g3 = ((bigH * bigH * (1 + bigH * bigH + bigW * bigW)) / ((1 + bigH * bigH) * (bigH * bigH + bigW * bigW))) ** (bigH * bigH);
  return (a + 0.25 * Math.log(g1 * g2 * g3)) / (Math.PI * bigW);
}

/** View factor from coaxial parallel disc 1 (radius r1) to disc 2 (radius r2) at distance l. */
export function viewFactorCoaxialDiscs(r1: number, r2: number, l: number): number {
  const bigR1 = r1 / l;
  const bigR2 = r2 / l;
  const s = 1 + (1 + bigR2 * bigR2) / (bigR1 * bigR1);
  return 0.5 * (s - Math.sqrt(s * s - 4 * (bigR2 / bigR1) ** 2));
}
