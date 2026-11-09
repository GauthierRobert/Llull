/** Morris elementary-effects screening (Morris 1991, Campolongo 2007 statistics): trajectories on a p-level grid of the unit hypercube. Pure. */

import { at } from './numerics';
import { createPrng } from './prng';

interface MorrisEffect {
  /** Mean of the elementary effects (sign kept: cancellation shows). */
  readonly mu: number;
  /** Mean of their absolute values (Campolongo mu*): overall influence. */
  readonly muStar: number;
  /** Sample standard deviation of the effects: non-linearity or interaction. */
  readonly sigma: number;
}

export interface MorrisResult {
  readonly effects: readonly MorrisEffect[];
  readonly evaluations: number;
  /** Delta = p / (2 (p - 1)), the step in unit-cube coordinates. */
  readonly delta: number;
}

/**
 * Elementary effects EE_i = (f(q + delta e_i) - f(q)) / delta of `f` on the unit hypercube, over `trajectories` random trajectories of d + 1 points.
 * @invariant exact for f linear in q: mu = mu* = coefficient, sigma = 0; evaluations = trajectories (d + 1); deterministic for the seed
 * @param trajectories at least 2 (the sample standard deviation needs two effects)
 * @param levels even grid size p >= 4; starting levels are k / (p - 1), k < p / 2, so every step of +delta stays inside [0, 1]
 */
export function elementaryEffects(
  f: (q: readonly number[]) => number,
  dimension: number,
  trajectories: number,
  levels: number,
  seed: number,
): MorrisResult {
  const prng = createPrng(seed);
  const delta = levels / (2 * (levels - 1));
  const effects: number[][] = Array.from({ length: dimension }, () => []);
  const pick = (count: number): number => Math.min(Math.floor(prng.uniform() * count), count - 1);
  for (let t = 0; t < trajectories; t += 1) {
    const point = Array.from({ length: dimension }, () => pick(levels / 2) / (levels - 1));
    const order = Array.from({ length: dimension }, (_, i) => i);
    for (let i = dimension - 1; i > 0; i -= 1) {
      const j = pick(i + 1);
      const swapped = order[j];
      order[j] = order[i] as number;
      order[i] = swapped as number;
    }
    let previous = f(point);
    for (const axis of order) {
      point[axis] = at(point, axis) + delta;
      const next = f(point);
      (effects[axis] as number[]).push((next - previous) / delta);
      previous = next;
    }
  }
  const summary = effects.map((values): MorrisEffect => {
    const n = values.length;
    const mu = values.reduce((sum, v) => sum + v, 0) / n;
    const muStar = values.reduce((sum, v) => sum + Math.abs(v), 0) / n;
    const variance = values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (n - 1);
    return { mu, muStar, sigma: Math.sqrt(variance) };
  });
  return { effects: summary, evaluations: trajectories * (dimension + 1), delta };
}
