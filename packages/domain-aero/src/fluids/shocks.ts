/** Normal and oblique shock relations of a calorically perfect gas (NACA Report 1135 eqs. 93-99, 128-150). */

import { bisect } from '@lib/bisect';

export interface NormalShock {
  readonly mach1: number;
  readonly mach2: number;
  /** p2 / p1 */
  readonly pressureRatio: number;
  /** ρ2 / ρ1 = V1 / V2 */
  readonly densityRatio: number;
  /** T2 / T1 */
  readonly temperatureRatio: number;
  /** p02 / p01 (total-pressure recovery) */
  readonly totalPressureRatio: number;
  /** p02 / p1 (Rayleigh pitot formula) */
  readonly pitotRatio: number;
}

/** Normal shock with upstream Mach M1 ≥ 1. */
export function normalShock(mach1: number, gamma: number): NormalShock {
  const m2 = mach1 * mach1;
  const mach2 = Math.sqrt((1 + ((gamma - 1) / 2) * m2) / (gamma * m2 - (gamma - 1) / 2));
  const pressureRatio = 1 + ((2 * gamma) / (gamma + 1)) * (m2 - 1);
  const densityRatio = ((gamma + 1) * m2) / ((gamma - 1) * m2 + 2);
  const temperatureRatio = pressureRatio / densityRatio;
  const totalPressureRatio = densityRatio ** (gamma / (gamma - 1)) * (1 / pressureRatio) ** (1 / (gamma - 1));
  const pitotRatio = pressureRatio * (1 + ((gamma - 1) / 2) * mach2 * mach2) ** (gamma / (gamma - 1));
  return { mach1, mach2, pressureRatio, densityRatio, temperatureRatio, totalPressureRatio, pitotRatio };
}

/** Flow deflection θ (rad) behind an oblique shock of wave angle β (rad): tan θ = 2 cot β (M² sin²β - 1) / (M² (γ + cos 2β) + 2). */
export function deflectionAngle(mach: number, beta: number, gamma: number): number {
  const m2 = mach * mach;
  const s = Math.sin(beta);
  return Math.atan((2 / Math.tan(beta)) * ((m2 * s * s - 1) / (m2 * (gamma + Math.cos(2 * beta)) + 2)));
}

/** Wave angle (rad) giving the maximum deflection for M (golden-section search on (μ, π/2)). */
export function maxDeflectionWaveAngle(mach: number, gamma: number): number {
  let low = Math.asin(1 / mach);
  let high = Math.PI / 2;
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let step = 0; step < 200; step += 1) {
    const a = high - ratio * (high - low);
    const b = low + ratio * (high - low);
    if (deflectionAngle(mach, a, gamma) < deflectionAngle(mach, b, gamma)) low = a;
    else high = b;
  }
  return (low + high) / 2;
}

export interface ObliqueShock {
  readonly mach1: number;
  readonly deflectionDeg: number;
  readonly waveAngleDeg: number;
  readonly normalMach1: number;
  readonly mach2: number;
  readonly pressureRatio: number;
  readonly densityRatio: number;
  readonly temperatureRatio: number;
  readonly totalPressureRatio: number;
  readonly maxDeflectionDeg: number;
}

const DEG = 180 / Math.PI;

/** Oblique shock from M1 and wave angle β (rad); the normal-shock relations on M1 sin β. */
export function obliqueShockFromWaveAngle(mach1: number, beta: number, gamma: number): ObliqueShock {
  const theta = deflectionAngle(mach1, beta, gamma);
  const normal = normalShock(mach1 * Math.sin(beta), gamma);
  return {
    mach1,
    deflectionDeg: theta * DEG,
    waveAngleDeg: beta * DEG,
    normalMach1: normal.mach1,
    mach2: normal.mach2 / Math.sin(beta - theta),
    pressureRatio: normal.pressureRatio,
    densityRatio: normal.densityRatio,
    temperatureRatio: normal.temperatureRatio,
    totalPressureRatio: normal.totalPressureRatio,
    maxDeflectionDeg: deflectionAngle(mach1, maxDeflectionWaveAngle(mach1, gamma), gamma) * DEG,
  };
}

/**
 * Oblique shock attached to a wedge of deflection θ (rad) on the weak or strong branch.
 * @failure θ above the maximum deflection for M1 (detached shock) -> null
 */
export function obliqueShockFromDeflection(mach1: number, theta: number, gamma: number, branch: 'weak' | 'strong'): ObliqueShock | null {
  const betaMax = maxDeflectionWaveAngle(mach1, gamma);
  if (theta > deflectionAngle(mach1, betaMax, gamma) + 1e-12) return null;
  const range =
    branch === 'weak'
      ? bisect((beta) => deflectionAngle(mach1, beta, gamma) < theta, Math.asin(1 / mach1), betaMax, 200)
      : bisect((beta) => deflectionAngle(mach1, beta, gamma) > theta, betaMax, Math.PI / 2, 200);
  return obliqueShockFromWaveAngle(mach1, (range.low + range.high) / 2, gamma);
}
