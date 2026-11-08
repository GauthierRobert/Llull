/** PHY-05 §5.7 / TR-NLS-05: limit (collapse) load of a load-displacement curve, pure. */

/** Element i of a numeric array; 0 for an index past the end (noUncheckedIndexedAccess identity, never an engineering default). */
const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

export type LimitMethod = 'peak' | 'plateau' | 'auto';

export interface PlateauParams {
  /** The plateau starts where the secant slope over `window` drops below slopeFraction x the initial slope. */
  readonly slopeFraction: number;
  /** Displacement window of the secant (curve displacement units). */
  readonly window: number;
}

export type LimitLoad =
  | {
      readonly found: 'peak';
      /** The sampled maximum (magnitude) and its displacement. */
      readonly sample: { readonly load: number; readonly displacement: number; readonly index: number };
      /** Vertex of the parabola through the three samples around the maximum, or the sample when they define none inside them. */
      readonly limitLoad: number;
      readonly atDisplacement: number;
    }
  | { readonly found: 'plateau'; readonly limitLoad: number; readonly atDisplacement: number; readonly index: number }
  | {
      readonly found: 'not_reached';
      /** Largest load magnitude on the curve: the structure carried at least this (a lower bound of the limit load). */
      readonly lowerBound: number;
      readonly atDisplacement: number;
    };

/** Sign that makes the entry of largest magnitude positive (+1 for an all-zero series). */
function orientation(series: readonly number[]): number {
  let best = 0;
  for (const value of series) if (Math.abs(value) > Math.abs(best)) best = value;
  return best < 0 ? -1 : 1;
}

/** Oriented copies (load and displacement grow positive) of a curve. */
function oriented(load: readonly number[], displacement: readonly number[]): { readonly P: number[]; readonly d: number[] } {
  const loadSign = orientation(load);
  const dispSign = orientation(displacement);
  const length = Math.min(load.length, displacement.length);
  return { P: load.slice(0, length).map((value) => loadSign * value), d: displacement.slice(0, length).map((value) => dispSign * value) };
}

/** First maximum with the displacement still increasing: P[i] >= P[i-1], P[i+1] < P[i], d[i+1] > d[i]; refined by a parabola in (d, P). */
function peakOf(P: readonly number[], d: readonly number[]): Extract<LimitLoad, { found: 'peak' }> | null {
  for (let i = 1; i + 1 < P.length; i++) {
    const [before, here, after] = [at(P, i - 1), at(P, i), at(P, i + 1)];
    const [x0, x1, x2] = [at(d, i - 1), at(d, i), at(d, i + 1)];
    if (!(here >= before && after < here && x2 > x1)) continue;
    const sample = { load: here, displacement: x1, index: i };
    const denominator = (x0 - x1) * (x0 - x2) * (x1 - x2);
    const a = denominator === 0 ? 0 : (x2 * (here - before) + x1 * (before - after) + x0 * (after - here)) / denominator;
    const b = denominator === 0 ? 0 : (x2 * x2 * (before - here) + x1 * x1 * (after - before) + x0 * x0 * (here - after)) / denominator;
    const vertexX = a < 0 ? -b / (2 * a) : Number.NaN;
    if (!(Number.isFinite(vertexX) && vertexX >= Math.min(x0, x1) && vertexX <= x2))
      return { found: 'peak', sample, limitLoad: here, atDisplacement: x1 };
    const c = before - a * x0 * x0 - b * x0;
    return { found: 'peak', sample, limitLoad: Math.max(here, c - (b * b) / (4 * a)), atDisplacement: vertexX };
  }
  return null;
}

/** Load at displacement `x` by linear interpolation along the curve from index `from` (displacement increasing), null past the end. */
function loadAt(P: readonly number[], d: readonly number[], from: number, x: number): number | null {
  for (let k = from; k + 1 < d.length; k++) {
    const [x0, x1] = [at(d, k), at(d, k + 1)];
    if (x1 >= x && x1 > x0) return at(P, k) + ((at(P, k + 1) - at(P, k)) * (x - x0)) / (x1 - x0);
  }
  return null;
}

/** First d[i] where the secant slope over [d[i], d[i] + window] is below slopeFraction x the initial slope (first segment with d > 0). */
function plateauOf(
  P: readonly number[],
  d: readonly number[],
  { slopeFraction, window }: PlateauParams,
): Extract<LimitLoad, { found: 'plateau' }> | null {
  const first = d.findIndex((value) => value > (d[0] ?? 0));
  if (first < 1) return null;
  const initial = (at(P, first) - at(P, 0)) / (at(d, first) - at(d, 0));
  if (!(initial > 0)) return null;
  for (let i = 0; i < P.length; i++) {
    const ahead = loadAt(P, d, i, (d[i] ?? 0) + window);
    if (ahead === null) return null;
    if ((ahead - (P[i] ?? 0)) / window < slopeFraction * initial)
      return { found: 'plateau', limitLoad: at(P, i), atDisplacement: at(d, i), index: i };
  }
  return null;
}

/**
 * Limit load of a curve (points in increment order, the unloaded origin first). Signs are normalised so that the load and the displacement of
 * largest magnitude count positive. `auto` = peak if a maximum exists, else not_reached; `plateau` falls back to not_reached when no plateau is found.
 * @invariant pure; values are magnitudes in the curve's units
 */
export function limitLoadOf(
  load: readonly number[],
  displacement: readonly number[],
  method: LimitMethod,
  plateau?: PlateauParams,
): LimitLoad {
  const { P, d } = oriented(load, displacement);
  const found = method === 'plateau' ? (plateau === undefined ? null : plateauOf(P, d, plateau)) : peakOf(P, d);
  if (found !== null) return found;
  let top = 0;
  for (let i = 1; i < P.length; i++) if (at(P, i) > at(P, top)) top = i;
  return { found: 'not_reached', lowerBound: Math.max(0, at(P, top)), atDisplacement: at(d, top) };
}
