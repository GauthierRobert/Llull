/** Which way an unsettled joint speed is going, so the warning can say it (a decelerating flywheel is not "accelerating"). */

export type SpeedTrend =
  | { readonly kind: 'accelerating' | 'decelerating'; readonly changeFraction: number }
  | { readonly kind: 'amplitude_decaying' | 'amplitude_growing'; readonly changeFraction: number }
  | { readonly kind: 'changing' | 'oscillating'; readonly changeFraction: number };

/** Relative change below which a trend is called neutral. */
const NEUTRAL = 0.01;
/** Local maxima of |v| below this fraction of the largest are ripple, not swing peaks. */
const MIN_PEAK = 0.2;

/** |v| at its local maxima (the speed peaks of an oscillation, in time order). */
function speedPeaks(velocity: readonly number[]): number[] {
  const magnitude = velocity.map(Math.abs);
  const largest = Math.max(...magnitude);
  return magnitude.flatMap((m, i) =>
    i > 0 && i < magnitude.length - 1 && m > (magnitude[i - 1] ?? 0) && m >= (magnitude[i + 1] ?? 0) && m >= MIN_PEAK * largest ? [m] : [],
  );
}

/**
 * Trend of an unsettled speed series. Sign-changing speed in the last 60 % of the run (an oscillation): the last speed peak against the
 * one a full cycle earlier (the envelope); one-signed speed: |v| at the end against |v| at the start of the last 10 % of the run.
 */
export function speedTrend(velocity: readonly number[]): SpeedTrend {
  const n = velocity.length;
  const late = velocity.slice(Math.floor(n * 0.4));
  if (Math.min(...late) < 0 && Math.max(...late) > 0) {
    const peaks = speedPeaks(velocity);
    const now = peaks[peaks.length - 1] ?? 0;
    const before = peaks[peaks.length - 3] ?? peaks[peaks.length - 2];
    if (before === undefined || before <= 0) return { kind: 'oscillating', changeFraction: 0 };
    const change = now / before - 1;
    if (change < -NEUTRAL) return { kind: 'amplitude_decaying', changeFraction: -change };
    if (change > NEUTRAL) return { kind: 'amplitude_growing', changeFraction: change };
    return { kind: 'oscillating', changeFraction: 0 };
  }
  const start = Math.abs(velocity[Math.floor(n * 0.9)] ?? 0);
  const end = Math.abs(velocity[n - 1] ?? 0);
  const change = start > 0 ? end / start - 1 : end > 0 ? Infinity : 0;
  if (change > 0) return { kind: 'accelerating', changeFraction: change };
  if (change < 0) return { kind: 'decelerating', changeFraction: -change };
  return { kind: 'changing', changeFraction: 0 };
}

/** The warning text for a joint whose speed has not settled. */
export function trendWarning(id: string, trend: SpeedTrend): string {
  const percent = (trend.changeFraction * 100).toFixed(trend.changeFraction * 100 < 10 ? 2 : 1);
  switch (trend.kind) {
    case 'accelerating':
      return `joint '${id}' is still accelerating at the end: simulate longer for its steady speed`;
    case 'decelerating':
      return `joint '${id}' is still decelerating at the end (speed ${percent} % lower over the last 10 % of the run): simulate longer for its steady speed`;
    case 'amplitude_decaying':
      return `joint '${id}' oscillates with an amplitude still decaying (speed peak ${percent} % lower than one cycle earlier): simulate longer to see it settle`;
    case 'amplitude_growing':
      return `joint '${id}' oscillates with a growing amplitude (speed peak ${percent} % higher than one cycle earlier): possibly unstable or driven`;
    case 'oscillating':
      return `joint '${id}' is oscillating and not yet periodic (too few speed peaks to tell whether it decays): simulate longer`;
    case 'changing':
      return `joint '${id}' is not yet steady (speed changing by ${percent} % over the last 10 % of the run): simulate longer`;
  }
}
