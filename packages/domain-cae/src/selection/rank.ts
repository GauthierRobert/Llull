/** Weighted ranking and Pareto set of material candidates (PHY-12 §5.5, TR-SEL-05, TR-SEL-07): pure, deterministic, no NaN. */

/** The named default of unspecified weights (FR-SEL-20). */
const EQUAL_WEIGHTS_SOURCE = 'equal weights: no weight given (TECHNICAL_SPEC 5.5, FR-SEL-20)';

export interface Weights {
  readonly value: readonly number[];
  readonly defaulted: boolean;
  readonly source?: string;
}

/** Normalised weights (sum 1): all given and >= 0 with a positive sum, or none given (equal, flagged defaulted); else a reason text. */
export function normaliseWeights(given: readonly (number | undefined)[]): Weights | string {
  const count = given.length;
  const some = given.filter((weight) => weight !== undefined).length;
  if (some === 0) return { value: given.map(() => 1 / count), defaulted: true, source: EQUAL_WEIGHTS_SOURCE };
  if (some !== count) return 'weights must be given for every objective or for none';
  const values = given.map((weight) => weight ?? Number.NaN);
  if (values.some((weight) => !Number.isFinite(weight) || weight < 0)) return 'a weight is negative or not a finite number';
  const sum = values.reduce((total, weight) => total + weight, 0);
  if (!(sum > 0)) return 'every weight is 0';
  return { value: values.map((weight) => weight / sum), defaulted: false };
}

export interface Scored<T> {
  readonly item: T;
  readonly id: string;
  /** One value per objective, higher is better. */
  readonly values: readonly number[];
}

/**
 * Score_i = sum_k w_k * I_k,i / max_j I_k,j; descending score, ties by ascending id; rank = 1-based position.
 * @invariant every value must be > 0 (callers exclude materials without one)
 */
export function rankScored<T>(
  candidates: readonly Scored<T>[],
  weights: readonly number[],
): { readonly item: T; readonly id: string; readonly rank: number; readonly score: number }[] {
  const best = weights.map((_, k) => Math.max(...candidates.map((candidate) => candidate.values[k] ?? 0)));
  return candidates
    .map((candidate) => ({
      item: candidate.item,
      id: candidate.id,
      score: weights.reduce((total, weight, k) => {
        const top = best[k];
        const value = candidate.values[k];
        return top === undefined || value === undefined ? total : total + (weight * value) / top;
      }, 0),
    }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry, position) => ({ ...entry, rank: position + 1 }));
}

/**
 * Pareto set of vectors to MINIMISE: ids not dominated by another (<= in every component and < in one). Ascending id order; O(N^2 k).
 * @invariant identical vectors do not dominate each other
 */
export function paretoSet(vectors: readonly { readonly id: string; readonly values: readonly number[] }[]): string[] {
  const dominates = (a: readonly number[], b: readonly number[]): boolean =>
    a.every((value, k) => value <= (b[k] ?? Number.POSITIVE_INFINITY)) && a.some((value, k) => value < (b[k] ?? Number.POSITIVE_INFINITY));
  return vectors
    .filter((candidate) => !vectors.some((other) => other.id !== candidate.id && dominates(other.values, candidate.values)))
    .map((candidate) => candidate.id)
    .sort();
}
