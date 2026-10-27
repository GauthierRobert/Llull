/**
 * Exact limit mask of a DART vertex of a Catmull-Clark level: an interior vertex of valence n with exactly one infinitely sharp edge. Its vertex rule
 * is the smooth one, but the sharp edge makes its edge point a plain midpoint, so the Halstead (smooth) mask is not its limit.
 *
 * The positions that decide v_k (the vertex), its n edge points E_i and its n face points F_j are closed under one refinement step: with
 * c_j = (v + E_j + F_j + E_{j-1}) / 4 the centre of face j (face j is [v, e_j, d_j, e_{j-1}], the order of `fanOf`),
 *   v'   = (mean_j c_j + 2 mean_i (v + E_i) / 2 + (n - 3) v) / n
 *   E'_i = (v + E_i + c_i + c_{i+1}) / 4   (smooth edge i),   (v + E_i) / 2   (the sharp edge)
 *   F'_j = c_j
 * a (2n + 1) square matrix S. At level 0 the same state is (v, e_i, d_j), and the limit is its left eigenvector for eigenvalue 1 (the power iteration
 * of the row of v converges geometrically) applied to that state. Without a sharp edge (`sharpIndex` -1) it is the Halstead mask. Pure.
 */

const MAX_ITERATIONS = 400;
const CONVERGED = 1e-16;

/** Weights over the state (v, e_0..e_{n-1}, d_0..d_{n-1}) of the limit position; `sharpIndex` is the fan index of the sharp edge or -1. */
export function dartMaskWeights(n: number, sharpIndex: number): number[] {
  const size = 2 * n + 1;
  const edge = (i: number): number => 1 + ((i + n) % n);
  const face = (j: number): number => 1 + n + ((j + n) % n);
  const rows: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const centre = (j: number): number[] => {
    const c = new Array<number>(size).fill(0);
    for (const index of [0, edge(j), face(j), edge(j - 1)]) c[index] = (c[index] as number) + 0.25;
    return c;
  };
  const add = (row: number[], vector: number[], factor: number): void =>
    vector.forEach((value, k) => (row[k] = (row[k] as number) + factor * value));
  const unit = (index: number): number[] => Object.assign(new Array<number>(size).fill(0), { [index]: 1 });
  const centres = Array.from({ length: n }, (_, j) => centre(j));
  const vertexRow = rows[0] as number[];
  for (let j = 0; j < n; j++) add(vertexRow, centres[j] as number[], 1 / (n * n));
  for (let i = 0; i < n; i++) {
    add(vertexRow, unit(0), 1 / (n * n));
    add(vertexRow, unit(edge(i)), 1 / (n * n));
  }
  add(vertexRow, unit(0), (n - 3) / n);
  for (let i = 0; i < n; i++) {
    const row = rows[edge(i)] as number[];
    if (i === sharpIndex) {
      add(row, unit(0), 0.5);
      add(row, unit(edge(i)), 0.5);
    } else {
      add(row, unit(0), 0.25);
      add(row, unit(edge(i)), 0.25);
      add(row, centres[i] as number[], 0.25);
      add(row, centres[(i + 1) % n] as number[], 0.25);
    }
    add(rows[face(i)] as number[], centres[i] as number[], 1);
  }
  let left = unit(0);
  for (let step = 0; step < MAX_ITERATIONS; step++) {
    const next = new Array<number>(size).fill(0);
    left.forEach((value, k) => value !== 0 && add(next, rows[k] as number[], value));
    const change = next.reduce((total, value, k) => Math.max(total, Math.abs(value - (left[k] as number))), 0);
    left = next;
    if (change < CONVERGED) break;
  }
  return left;
}

const cache = new Map<string, number[]>();

/** `dartMaskWeights` memoised by valence and sharp fan index. */
export function dartMask(n: number, sharpIndex: number): number[] {
  const key = `${n}:${sharpIndex}`;
  let weights = cache.get(key);
  if (weights === undefined) {
    weights = dartMaskWeights(n, sharpIndex);
    cache.set(key, weights);
  }
  return weights;
}
