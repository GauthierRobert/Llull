/**
 * Free-form deformation by a Bernstein lattice (01 DEF §5.3, Sederberg & Parry 1986): the image of a point of the box is
 * X(s, t, u) = Σ B_i^l(s) B_j^m(t) B_k^n(u) P_ijk with P_ijk the regular lattice point displaced by its offset. Bernstein polynomials reproduce
 * linear functions, so a lattice whose offsets all vanish is the identity and one whose points move by an affine map is that affine map.
 * @invariant points outside the box are not moved
 */

import type { DeformLaw } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';

export type LatticeLaw = Extract<DeformLaw, { kind: 'lattice' }>;

type Rows = [Vec3, Vec3, Vec3];

const AXES = [0, 1, 2] as const;

const binomial = (n: number, k: number): number => {
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
  return value;
};

/** B_i^n(t) for i = 0..n. */
function bernsteinBasis(n: number, t: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(binomial(n, i) * t ** i * (1 - t) ** (n - i));
  return out;
}

/** dB_i^n/dt for i = 0..n (n (B_{i-1}^{n-1} - B_i^{n-1})). */
function bernsteinSlope(n: number, t: number): number[] {
  const lower = bernsteinBasis(n - 1, t);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(n * ((lower[i - 1] ?? 0) - (lower[i] ?? 0)));
  return out;
}

const dense = new WeakMap<LatticeLaw, Float64Array>();

/** Offsets of every control point (i-major, then j, then k; three numbers each); control points named twice add up. */
function denseOffsets(law: LatticeLaw): Float64Array {
  const known = dense.get(law);
  if (known !== undefined) return known;
  const [l, m, n] = law.degrees;
  const out = new Float64Array(3 * (l + 1) * (m + 1) * (n + 1));
  for (const { index, delta } of law.offsets) {
    const slot = (index[0] * (m + 1) + index[1]) * (n + 1) + index[2];
    for (const axis of AXES) out[3 * slot + axis] = (out[3 * slot + axis] as number) + delta[axis];
  }
  dense.set(law, out);
  return out;
}

/** Normalised lattice coordinates of local point `q`, or null when it lies outside the box. */
function normalised(law: LatticeLaw, q: Vec3): Vec3 | null {
  const s: [number, number, number] = [0, 0, 0];
  for (const a of AXES) {
    const size = law.box.max[a] - law.box.min[a];
    const t = (q[a] - law.box.min[a]) / size;
    if (!(t >= 0 && t <= 1)) return null;
    s[a] = t;
  }
  return s;
}

/** The image of local point `q`. */
export function latticeMap(law: LatticeLaw, q: Vec3): Vec3 {
  const s = normalised(law, q);
  if (s === null) return q;
  const [l, m, n] = law.degrees;
  const offsets = denseOffsets(law);
  const [bi, bj, bk] = [bernsteinBasis(l, s[0]), bernsteinBasis(m, s[1]), bernsteinBasis(n, s[2])];
  const out: [number, number, number] = [q[0], q[1], q[2]];
  for (let i = 0; i <= l; i++)
    for (let j = 0; j <= m; j++)
      for (let k = 0; k <= n; k++) {
        const weight = (bi[i] as number) * (bj[j] as number) * (bk[k] as number);
        const at = 3 * ((i * (m + 1) + j) * (n + 1) + k);
        for (const axis of AXES) out[axis] += weight * (offsets[at + axis] as number);
      }
  return out;
}

/** Jacobian rows ∂X_a/∂q_b of the map at `q` (identity outside the box). */
export function latticeJacobian(law: LatticeLaw, q: Vec3): Rows {
  const identity: Rows = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const s = normalised(law, q);
  if (s === null) return identity;
  const [l, m, n] = law.degrees;
  const offsets = denseOffsets(law);
  const basis = [bernsteinBasis(l, s[0]), bernsteinBasis(m, s[1]), bernsteinBasis(n, s[2])] as const;
  const slope = [bernsteinSlope(l, s[0]), bernsteinSlope(m, s[1]), bernsteinSlope(n, s[2])] as const;
  const size = [0, 1, 2].map((a) => (law.box.max[a] as number) - (law.box.min[a] as number));
  const rows: Rows = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let i = 0; i <= l; i++)
    for (let j = 0; j <= m; j++)
      for (let k = 0; k <= n; k++) {
        const at = 3 * ((i * (m + 1) + j) * (n + 1) + k);
        const index = [i, j, k] as const;
        for (const b of AXES) {
          let weight = 1;
          for (const a of AXES) weight *= a === b ? (slope[a][index[a]] as number) : (basis[a][index[a]] as number);
          weight /= size[b] as number;
          for (const a of AXES) (rows[a] as [number, number, number])[b] += weight * (offsets[at + a] as number);
        }
      }
  return rows;
}

const det3 = ([a, b, c]: Rows): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);

/** det J of the lattice map at `q`. */
export const latticeDeterminant = (law: LatticeLaw, q: Vec3): number => det3(latticeJacobian(law, q));

/** Inverse of the Bernstein-Vandermonde matrix of degree `d` at the nodes i / d: converts values at the nodes to Bernstein coefficients. */
function bernsteinInverse(d: number): number[][] {
  const size = d + 1;
  const matrix = Array.from({ length: size }, (_, i) => {
    const row = bernsteinBasis(d, d === 0 ? 0 : i / d);
    return [...row, ...Array.from({ length: size }, (_, j) => (i === j ? 1 : 0))];
  });
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let r = column + 1; r < size; r++)
      if (Math.abs((matrix[r] as number[])[column] as number) > Math.abs((matrix[pivot] as number[])[column] as number)) pivot = r;
    [matrix[column], matrix[pivot]] = [matrix[pivot] as number[], matrix[column] as number[]];
    const head = (matrix[column] as number[])[column] as number;
    matrix[column] = (matrix[column] as number[]).map((value) => value / head);
    for (let r = 0; r < size; r++) {
      if (r === column) continue;
      const factor = (matrix[r] as number[])[column] as number;
      if (factor === 0) continue;
      matrix[r] = (matrix[r] as number[]).map((value, c) => value - factor * ((matrix[column] as number[])[c] as number));
    }
  }
  return matrix.map((row) => row.slice(size));
}

export interface DeterminantBounds {
  /** Extremes of the Bernstein coefficients of det J over the box: the polynomial lies between them everywhere (convex hull property). */
  readonly boundMin: number;
  readonly boundMax: number;
  /** Extremes of det J itself: the smallest and largest value of a grid over the box, each polished by a local pattern search (inside the bound). */
  readonly sampledMin: number;
  readonly sampledMax: number;
  /** Local point of the smallest sampled value. */
  readonly sampledMinAt: Vec3;
}

/** Samples per axis of the polishing grid (capped: a degree 8 lattice has 24 coefficients per axis). */
const GRID_CAP = 25;

/** Local pattern search from `start` (normalised coordinates) for the minimum of `sign` x f: steps of `step` halve until they vanish. */
function polish(f: (s: Vec3) => number, start: Vec3, step: number, sign: 1 | -1): { value: number; at: Vec3 } {
  let at: Vec3 = start;
  let value = sign * f(at);
  for (let h = step; h > 1e-11; ) {
    let moved = false;
    for (const axis of AXES)
      for (const direction of [-1, 1]) {
        const next = [...at] as [number, number, number];
        next[axis] = Math.min(1, Math.max(0, next[axis] + direction * h));
        const candidate = sign * f(next);
        if (candidate < value - 1e-15) {
          at = next;
          value = candidate;
          moved = true;
        }
      }
    if (!moved) h /= 2;
  }
  return { value: sign * value, at };
}

/**
 * Range of det J over the box. det J is a polynomial of degree 3l - 1, 3m - 1, 3n - 1 in (s, t, u); it is sampled at the nodes i / D of that degree, converted
 * to Bernstein coefficients, and their extremes bound it (Sederberg & Parry: "the largest and smallest coefficients bound the volume change").
 */
export function determinantBounds(law: LatticeLaw): DeterminantBounds {
  const degrees = law.degrees.map((degree) => 3 * degree - 1);
  const [dx, dy, dz] = degrees as [number, number, number];
  const at = (s: number, t: number, u: number): Vec3 => [
    law.box.min[0] + s * (law.box.max[0] - law.box.min[0]),
    law.box.min[1] + t * (law.box.max[1] - law.box.min[1]),
    law.box.min[2] + u * (law.box.max[2] - law.box.min[2]),
  ];
  const values = new Float64Array((dx + 1) * (dy + 1) * (dz + 1));
  let sampledMin = Infinity;
  let sampledMax = -Infinity;
  let minNode: Vec3 = [0, 0, 0];
  let maxNode: Vec3 = [0, 0, 0];
  for (let i = 0; i <= dx; i++)
    for (let j = 0; j <= dy; j++)
      for (let k = 0; k <= dz; k++) {
        const value = latticeDeterminant(law, at(i / dx, j / dy, k / dz));
        values[(i * (dy + 1) + j) * (dz + 1) + k] = value;
        if (value < sampledMin) {
          sampledMin = value;
          minNode = [i / dx, j / dy, k / dz];
        }
        if (value > sampledMax) {
          sampledMax = value;
          maxNode = [i / dx, j / dy, k / dz];
        }
      }
  // a denser grid (the nodes of the interpolation are not where a polynomial peaks), then a local search from the best points of both
  const dense = (axisDegree: number): number => Math.min(GRID_CAP, 6 * axisDegree + 1);
  const [gx, gy, gz] = [dense(dx), dense(dy), dense(dz)];
  const determinantAt = (s: Vec3): number => latticeDeterminant(law, at(s[0], s[1], s[2]));
  for (let i = 0; i < gx; i++)
    for (let j = 0; j < gy; j++)
      for (let k = 0; k < gz; k++) {
        const s: Vec3 = [i / (gx - 1), j / (gy - 1), k / (gz - 1)];
        const value = determinantAt(s);
        if (value < sampledMin) {
          sampledMin = value;
          minNode = s;
        }
        if (value > sampledMax) {
          sampledMax = value;
          maxNode = s;
        }
      }
  const lowest = polish(determinantAt, minNode, 0.5 / Math.max(gx, gy, gz), 1);
  const highest = polish(determinantAt, maxNode, 0.5 / Math.max(gx, gy, gz), -1);
  sampledMin = Math.min(sampledMin, lowest.value);
  sampledMax = Math.max(sampledMax, highest.value);
  const sampledMinAt = at(lowest.at[0], lowest.at[1], lowest.at[2]);
  // values at the nodes -> Bernstein coefficients, one axis at a time
  const apply = (grid: Float64Array, axis: 0 | 1 | 2): Float64Array => {
    const inverse = bernsteinInverse(degrees[axis] as number);
    const out = new Float64Array(grid.length);
    const stride = [(dy + 1) * (dz + 1), dz + 1, 1] as const;
    const count = [dx + 1, dy + 1, dz + 1] as const;
    for (let i = 0; i < count[0]; i++)
      for (let j = 0; j < count[1]; j++)
        for (let k = 0; k < count[2]; k++) {
          const here = [i, j, k] as const;
          const base = i * stride[0] + j * stride[1] + k * stride[2] - here[axis] * stride[axis];
          let sum = 0;
          for (let r = 0; r < count[axis]; r++)
            sum += ((inverse[here[axis]] as number[])[r] as number) * (grid[base + r * stride[axis]] as number);
          out[i * stride[0] + j * stride[1] + k * stride[2]] = sum;
        }
    return out;
  };
  const coefficients = apply(apply(apply(values, 0), 1), 2);
  let boundMin = Infinity;
  let boundMax = -Infinity;
  for (const value of coefficients) {
    boundMin = Math.min(boundMin, value);
    boundMax = Math.max(boundMax, value);
  }
  return { boundMin, boundMax, sampledMin, sampledMax, sampledMinAt };
}
