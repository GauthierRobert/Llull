/**
 * Dryden turbulence of a flight scenario (13 FLT M4, TR-FLT-04): the MIL-HDBK-1797 spectra realised by forming filters on a seeded Gaussian white
 * noise (Philox counter RNG: draw i is a pure function of (seed, axis, i)). Frozen-field model at the stated airspeed V (Taylor: Ω = ω / V), world
 * axes x / y / z for the longitudinal / lateral / vertical components.
 *
 *   Φu(ω) = σ² (2L/πV) / (1 + (Lω/V)²)                        H = σ √(2L/πV) / (1 + τs)
 *   Φv(ω) = σ² (L/πV) (1 + 3(Lω/V)²) / (1 + (Lω/V)²)²          H = σ √(L/πV) (1 + √3 τs) / (1 + τs)²
 *
 * with τ = L/V, one-sided in ω so that ∫₀^∞ Φ dω = σ². The lateral and vertical components share the second-order form.
 */

import type { Vec3 } from '@core/model/vectors';
import { boxMuller, philox4x32, philoxKey } from '@lib/prng';

/** Spacing of the realised turbulence samples, s (the wind between them is interpolated linearly). */
export const TURBULENCE_STEP_S = 0.005;

/** Largest number of samples of one realisation (600 s at TURBULENCE_STEP_S). */
const MAX_SAMPLES = 120_001;

export interface DrydenSpec {
  /** Standard deviation of the u, v, w components, m/s. */
  readonly sigmaMps: Vec3;
  /** Scale length of the u, v, w components, m. */
  readonly lengthScaleM: Vec3;
  /** Airspeed that converts the spatial spectrum to time, m/s. */
  readonly airspeedMps: number;
  /** Seed of the noise, an integer 0 <= seed < 2^53. */
  readonly seed: number;
}

/** Analytic one-sided PSD (m²/s² per rad/s) of component `axis` (0 = u longitudinal, 1 and 2 = lateral / vertical) at ω rad/s. */
export function drydenPsd(spec: DrydenSpec, axis: 0 | 1 | 2, omega: number): number {
  const sigma = spec.sigmaMps[axis];
  const length = spec.lengthScaleM[axis];
  const v = spec.airspeedMps;
  const x = (length * omega) / v;
  return axis === 0
    ? (sigma * sigma * 2 * length) / (Math.PI * v) / (1 + x * x)
    : (sigma * sigma * length * (1 + 3 * x * x)) / (Math.PI * v * (1 + x * x) ** 2);
}

/** Standard normal sample of the stream (seed, axis) at index `index`. */
function gaussian(key: readonly [number, number], axis: number, index: number, out: Uint32Array): number {
  philox4x32(index >>> 0, Math.floor(index / 4294967296), axis, 0, key[0], key[1], out);
  return boxMuller(out[0] as number, out[1] as number);
}

/**
 * Turbulence velocity at `count` samples spaced TURBULENCE_STEP_S: `[u, v, w][k]`. Each component is a cascade of exact first-order stages
 * (zero-order hold of the input over a step) driven by white noise of PSD π, started in its stationary state.
 */
export function drydenSeries(spec: DrydenSpec, count: number): readonly Vec3[] {
  const samples = Math.min(MAX_SAMPLES, Math.max(2, count));
  const key = philoxKey(spec.seed);
  const words = new Uint32Array(4);
  const dt = TURBULENCE_STEP_S;
  const columns = ([0, 1, 2] as const).map((axis) => {
    const sigma = spec.sigmaMps[axis];
    const length = spec.lengthScaleM[axis];
    const tau = length / spec.airspeedMps;
    const decay = Math.exp(-dt / tau);
    const noise = Math.sqrt(Math.PI / dt);
    const gain = axis === 0 ? sigma * Math.sqrt((2 * tau) / Math.PI) : sigma * Math.sqrt(tau / Math.PI);
    const out = new Float64Array(samples);
    // stage 1 = w / (1 + τs); stage 2 = stage1 / (1 + τs); u = gain·stage1, v/w = gain·((1 − √3)·stage2 + √3·stage1)
    let y1 = 0;
    let y2 = 0;
    for (let k = -Math.ceil((8 * tau) / dt); k < samples; k++) {
      const white = noise * gaussian(key, axis, k + Math.ceil((8 * tau) / dt), words);
      y1 = decay * y1 + (1 - decay) * white;
      y2 = decay * y2 + (1 - decay) * y1;
      if (k >= 0) out[k] = gain * (axis === 0 ? y1 : (1 - Math.sqrt(3)) * y2 + Math.sqrt(3) * y1);
    }
    return out;
  });
  return Array.from({ length: samples }, (_, k) => [columns[0]?.[k] ?? 0, columns[1]?.[k] ?? 0, columns[2]?.[k] ?? 0] as Vec3);
}
