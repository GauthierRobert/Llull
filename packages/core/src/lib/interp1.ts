function interpolateKnots(count: number, xAt: (index: number) => number, yAt: (index: number) => number, x: number, empty: number): number {
  if (count === 0) return empty;
  if (x <= xAt(0)) return yAt(0);
  if (x >= xAt(count - 1)) return yAt(count - 1);
  let [lo, hi] = [0, count - 1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xAt(mid) >= x) hi = mid;
    else lo = mid;
  }
  const [x0, y0] = [xAt(lo), yAt(lo)];
  return y0 + ((yAt(hi) - y0) * (x - x0)) / (xAt(hi) - x0);
}

/**
 * Piecewise-linear `y(x)` through knots `(xs[k], ys[k])` (`xs` non-decreasing), end values held outside the table.
 * A knot hit is interpolated from the interval below it; `empty` is returned for a table without knots.
 */
export function interp1(xs: readonly number[], ys: readonly number[], x: number, empty = 0): number {
  return interpolateKnots(
    Math.min(xs.length, ys.length),
    (index) => xs[index] ?? 0,
    (index) => ys[index] ?? 0,
    x,
    empty,
  );
}

/** `interp1` over `[x, y]` knot pairs. */
export function interp1Pairs(points: ReadonlyArray<readonly [number, number]>, x: number, empty = 0): number {
  return interpolateKnots(
    points.length,
    (index) => points[index]?.[0] ?? 0,
    (index) => points[index]?.[1] ?? 0,
    x,
    empty,
  );
}
