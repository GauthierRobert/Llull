/** Periodic steady state of a sampled signal (an oscillator, a crank with torque ripple): the period, found cycle against cycle. */

/** Shortest period considered, samples: fewer cannot show a cycle. */
const MIN_LAG = 4;
/** Lag search resolution, samples (linear interpolation between samples). */
const LAG_STEP = 0.25;
/** The last cycle matches the one before within this rms fraction of the peak-to-peak of the two cycles. */
const MATCH_TOLERANCE = 0.05;
/** A cycle must show at least this fraction of the peak-to-peak (rejects slow ramps and constant signals). */
const MIN_CYCLE_RANGE = 0.5;
/** Peak-to-peak below this fraction of the largest |value| is no oscillation (numerical noise on a constant). */
const MIN_RELATIVE_RANGE = 1e-3;

export interface Period {
  readonly periodS: number;
  /** Samples in the last full cycle (the window to average over). */
  readonly windowSamples: number;
}

function interpolate(values: readonly number[], index: number): number {
  const base = Math.floor(index);
  const fraction = index - base;
  return (values[base] ?? 0) * (1 - fraction) + (values[base + 1] ?? values[base] ?? 0) * fraction;
}

/** rms difference between the last `width` samples and the same signal `lag` samples earlier, or null when the cycle is no oscillation. */
function cycleMismatch(values: readonly number[], lag: number): number | null {
  const n = values.length;
  const width = Math.ceil(lag);
  const recent = values.slice(n - width);
  const both = values.slice(n - 2 * width);
  const [low, high] = [Math.min(...both), Math.max(...both)];
  const range = high - low;
  const largest = Math.max(...both.map(Math.abs));
  if (range <= MIN_RELATIVE_RANGE * largest || range <= 1e-12) return null;
  if (Math.max(...recent) - Math.min(...recent) < MIN_CYCLE_RANGE * range) return null;
  const squares = Array.from({ length: width }, (_, k) => (values[n - width + k] ?? 0) - interpolate(values, n - width + k - lag));
  return Math.sqrt(squares.reduce((total, d) => total + d * d, 0) / width) / range;
}

/**
 * The period of the tail of a uniformly sampled signal, or null when the last two cycles differ (transient, drift, decay) or there is
 * no oscillation. Needs at least three cycles of samples.
 */
export function findPeriod(values: readonly number[], times: readonly number[]): Period | null {
  const n = values.length;
  const dt = n > 1 ? ((times[n - 1] ?? 0) - (times[0] ?? 0)) / (n - 1) : 0;
  if (n < 3 * MIN_LAG || !(dt > 0)) return null;
  let best: { lag: number; error: number } | null = null;
  for (let lag = MIN_LAG; lag <= n / 3; lag += LAG_STEP) {
    const error = cycleMismatch(values, lag);
    if (error === null) continue;
    if (best === null && error <= MATCH_TOLERANCE) best = { lag, error };
    else if (best !== null && error < best.error) best = { lag, error };
    else if (best !== null) break;
  }
  return best === null ? null : { periodS: best.lag * dt, windowSamples: Math.max(1, Math.round(best.lag)) };
}

/** Mean of the last `window` samples of `values`. */
export function tailMean(values: readonly number[], window: number): number {
  const tail = values.slice(Math.max(0, values.length - window));
  return tail.length === 0 ? 0 : tail.reduce((total, v) => total + v, 0) / tail.length;
}
