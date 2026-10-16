// Pure helpers for SeriesChart / TimelineDock: monotone interpolation between two aligned sample arrays, decimation, axis ticks.

/** y at `x` by linear interpolation over ascending `xs` (clamped to the ends). */
export function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  const last = Math.min(xs.length, ys.length) - 1;
  if (last < 0) return 0;
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0;
  if (x >= (xs[last] ?? 0)) return ys[last] ?? 0;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((xs[mid] ?? 0) <= x) low = mid;
    else high = mid;
  }
  const x0 = xs[low] ?? 0;
  const span = (xs[high] ?? 0) - x0;
  const y0 = ys[low] ?? 0;
  return span <= 0 ? y0 : y0 + (((ys[high] ?? 0) - y0) * (x - x0)) / span;
}

/** Indices to draw: every `stride`-th sample plus the last, so a path never exceeds ~`maxPoints`. */
export function decimatedIndices(length: number, maxPoints: number): number[] {
  if (length <= 0) return [];
  const stride = Math.max(1, Math.floor(length / maxPoints));
  const indices: number[] = [];
  for (let i = 0; i < length; i += stride) indices.push(i);
  if (indices[indices.length - 1] !== length - 1) indices.push(length - 1);
  return indices;
}

/** Compact axis label: 1.2k above a thousand. */
export function formatTick(value: number): string {
  return Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(Math.abs(value) < 10 && value !== 0 ? 1 : 0);
}

/** Series rank: priority ids first, then by peak magnitude. */
export function pickSeries<T extends { readonly id: string; readonly values: readonly number[] }>(
  series: readonly T[],
  priority: readonly string[],
  max: number,
): T[] {
  const peak = (values: readonly number[]): number => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const rank = (id: string): number => (priority.includes(id) ? 0 : 1);
  return [...series].sort((a, b) => rank(a.id) - rank(b.id) || peak(b.values) - peak(a.values)).slice(0, max);
}
