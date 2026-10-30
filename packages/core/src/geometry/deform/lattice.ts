/**
 * Free-form deformation by a lattice (01 DEF §5.3, Sederberg & Parry 1986): the image of a point of the box is
 * X(s, t, u) = Σ B_i(s) B_j(t) B_k(u) P_ijk with P_ijk the regular lattice point displaced by its offset. The basis is Bernstein by default (a Bézier lattice:
 * every control point acts everywhere) or a uniform clamped B-spline of degrees [p, q, r] (`splineDegrees`: local control); both reproduce linear
 * functions, so a lattice whose offsets all vanish is the identity and one whose points move by an affine map is that affine map. The box is aligned with the
 * frame, or oriented along its own axes (`axes`).
 * @invariant points outside the box are not moved
 */

import type { DeformLaw } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';

export type LatticeLaw = Extract<DeformLaw, { kind: 'lattice' }>;

type Rows = [Vec3, Vec3, Vec3];

const AXES = [0, 1, 2] as const;

/** Relative slack of the oriented box faces (normalised coordinates). */
const FACE_SLACK = 1e-12;

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

/** Knot j of the uniform clamped vector of `count` control points and degree `p`: p + 1 zeros, count - p - 1 interior knots, p + 1 ones. */
const knotAt = (count: number, p: number, j: number): number => (j <= p ? 0 : j >= count ? 1 : (j - p) / (count - p));

/** The nonzero B-spline functions of degree `degree` at `s` in span `k` (Piegl & Tiller A2.2): N_{k-degree..k}. */
function splineValues(count: number, p: number, k: number, degree: number, s: number): number[] {
  const values = [1];
  const left: number[] = [0];
  const right: number[] = [0];
  for (let j = 1; j <= degree; j++) {
    left[j] = s - knotAt(count, p, k + 1 - j);
    right[j] = knotAt(count, p, k + j) - s;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = (values[r] as number) / ((right[r + 1] as number) + (left[j - r] as number));
      values[r] = saved + (right[r + 1] as number) * temp;
      saved = (left[j - r] as number) * temp;
    }
    values[j] = saved;
  }
  return values;
}

/** Index of the knot span of `s` (p .. count - 1; s = 1 belongs to the last). */
const spanOf = (count: number, p: number, s: number): number => Math.min(count - 1, p + Math.floor(s * (count - p)));

interface AxisBasis {
  /** Index of the first control point the functions act on. */
  readonly first: number;
  readonly values: number[];
  /** d/ds of each function (computed on demand). */
  readonly slopes: number[];
}

/** The nonzero basis functions of one axis at normalised `s`: all net + 1 Bernstein ones, or the p + 1 B-spline ones of its span. */
function axisBasis(law: LatticeLaw, axis: 0 | 1 | 2, s: number, withSlopes: boolean): AxisBasis {
  const net = law.degrees[axis];
  const p = law.splineDegrees?.[axis];
  if (p === undefined) return { first: 0, values: bernsteinBasis(net, s), slopes: withSlopes ? bernsteinSlope(net, s) : [] };
  const count = net + 1;
  const k = spanOf(count, p, s);
  const values = splineValues(count, p, k, p, s);
  const slopes: number[] = [];
  if (withSlopes) {
    const lower = splineValues(count, p, k, p - 1, s);
    for (let r = 0; r <= p; r++) {
      const i = k - p + r;
      const a = knotAt(count, p, i + p) - knotAt(count, p, i);
      const b = knotAt(count, p, i + p + 1) - knotAt(count, p, i + 1);
      slopes.push(p * ((r >= 1 && a > 0 ? (lower[r - 1] as number) / a : 0) - (r <= p - 1 && b > 0 ? (lower[r] as number) / b : 0)));
    }
  }
  return { first: k - p, values, slopes };
}

/** Rest position of control point `i` on one axis in normalised coordinates: i / net for Bernstein, the Greville abscissa for a B-spline. */
export function restPosition(law: Pick<LatticeLaw, 'degrees' | 'splineDegrees'>, axis: 0 | 1 | 2, i: number): number {
  const net = law.degrees[axis];
  const p = law.splineDegrees?.[axis];
  if (p === undefined) return i / net;
  let sum = 0;
  for (let j = 1; j <= p; j++) sum += knotAt(net + 1, p, i + j);
  return sum / p;
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

/** Box coordinates of the frame point `q` (the box's own axes, about the frame origin); the point itself for a frame-aligned box. */
export function toBoxCoordinates(law: Pick<LatticeLaw, 'axes'>, q: Vec3): Vec3 {
  const { axes } = law;
  if (axes === undefined) return q;
  return [
    axes[0][0] * q[0] + axes[0][1] * q[1] + axes[0][2] * q[2],
    axes[1][0] * q[0] + axes[1][1] * q[1] + axes[1][2] * q[2],
    axes[2][0] * q[0] + axes[2][1] * q[1] + axes[2][2] * q[2],
  ];
}

/** The frame point of box coordinates `c` (inverse of `toBoxCoordinates`: the axes are orthonormal). */
export function fromBoxCoordinates(law: Pick<LatticeLaw, 'axes'>, c: Vec3): Vec3 {
  const { axes } = law;
  if (axes === undefined) return c;
  return [
    axes[0][0] * c[0] + axes[1][0] * c[1] + axes[2][0] * c[2],
    axes[0][1] * c[0] + axes[1][1] * c[1] + axes[2][1] * c[2],
    axes[0][2] * c[0] + axes[1][2] * c[1] + axes[2][2] * c[2],
  ];
}

/** Normalised lattice coordinates of local point `q`, or null when it lies outside the box. */
function normalised(law: LatticeLaw, q: Vec3): Vec3 | null {
  const c = toBoxCoordinates(law, q);
  const s: [number, number, number] = [0, 0, 0];
  for (const a of AXES) {
    const size = law.box.max[a] - law.box.min[a];
    const t = (c[a] - law.box.min[a]) / size;
    // an oriented box is reached through a rotation: a point on a face may land 1e-16 outside it
    const slack = law.axes === undefined ? 0 : FACE_SLACK;
    if (!(t >= -slack && t <= 1 + slack)) return null;
    s[a] = Math.min(Math.max(t, 0), 1);
  }
  return s;
}

/** The image of local point `q`. */
export function latticeMap(law: LatticeLaw, q: Vec3): Vec3 {
  const s = normalised(law, q);
  if (s === null) return q;
  const [m, n] = [law.degrees[1], law.degrees[2]];
  const offsets = denseOffsets(law);
  const [bi, bj, bk] = [axisBasis(law, 0, s[0], false), axisBasis(law, 1, s[1], false), axisBasis(law, 2, s[2], false)];
  const out: [number, number, number] = [q[0], q[1], q[2]];
  for (let ii = 0; ii < bi.values.length; ii++)
    for (let jj = 0; jj < bj.values.length; jj++)
      for (let kk = 0; kk < bk.values.length; kk++) {
        const weight = (bi.values[ii] as number) * (bj.values[jj] as number) * (bk.values[kk] as number);
        const at = 3 * (((bi.first + ii) * (m + 1) + bj.first + jj) * (n + 1) + bk.first + kk);
        for (const axis of AXES) out[axis] += weight * (offsets[at + axis] as number);
      }
  return out;
}

/** Jacobian rows ∂X_a/∂q_b of the map at `q` (identity outside the box). */
export function latticeJacobian(law: LatticeLaw, q: Vec3): Rows {
  const s = normalised(law, q);
  if (s === null)
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  return jacobianAtNormalised(law, s);
}

/** The Jacobian at the normalised box coordinates `s` (inside the box), with no round trip through frame coordinates. */
function jacobianAtNormalised(law: LatticeLaw, s: Vec3): Rows {
  const [m, n] = [law.degrees[1], law.degrees[2]];
  const offsets = denseOffsets(law);
  const basis = [axisBasis(law, 0, s[0], true), axisBasis(law, 1, s[1], true), axisBasis(law, 2, s[2], true)] as const;
  const size = [0, 1, 2].map((a) => (law.box.max[a] as number) - (law.box.min[a] as number));
  // frame-aligned: the offsets' derivatives are added to the identity rows in place; oriented: they are ∂/∂c and turn by the axes afterwards
  const oriented = law.axes !== undefined;
  const rows: Rows = oriented
    ? [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]
    : [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
  for (let ii = 0; ii < basis[0].values.length; ii++)
    for (let jj = 0; jj < basis[1].values.length; jj++)
      for (let kk = 0; kk < basis[2].values.length; kk++) {
        const index = [ii, jj, kk] as const;
        const at = 3 * (((basis[0].first + ii) * (m + 1) + basis[1].first + jj) * (n + 1) + basis[2].first + kk);
        for (const b of AXES) {
          let weight = 1;
          for (const a of AXES) weight *= a === b ? (basis[a].slopes[index[a]] as number) : (basis[a].values[index[a]] as number);
          weight /= size[b] as number;
          for (const a of AXES) (rows[a] as [number, number, number])[b] += weight * (offsets[at + a] as number);
        }
      }
  if (!oriented) return rows;
  const axes = law.axes as NonNullable<LatticeLaw['axes']>;
  return AXES.map((a) =>
    AXES.map((b) => (a === b ? 1 : 0) + rows[a][0] * axes[0][b] + rows[a][1] * axes[1][b] + rows[a][2] * axes[2][b]),
  ) as unknown as Rows;
}

const det3 = ([a, b, c]: Rows): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);

/** det J of the lattice map at `q`. */
export const latticeDeterminant = (law: LatticeLaw, q: Vec3): number => det3(latticeJacobian(law, q));

/** det J at the normalised box coordinates `s`: what the bounds use, so a node on a face of an oriented box is not lost to the frame round trip. */
const determinantAtNormalised = (law: LatticeLaw, s: Vec3): number => det3(jacobianAtNormalised(law, s));

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
  /** Extremes of the Bernstein coefficients of det J over the box (per knot span for a B-spline lattice): det J lies between them everywhere (convex hull property). */
  readonly boundMin: number;
  readonly boundMax: number;
  /** Extremes of det J itself: the smallest and largest value of a grid over the box, each polished by a local pattern search (inside the bound). */
  readonly sampledMin: number;
  readonly sampledMax: number;
  /** Local point of the smallest sampled value. */
  readonly sampledMinAt: Vec3;
}

/** Samples per axis of the grid inside each knot span of a B-spline lattice. */
const SPAN_GRID = 7;

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

/** Local frame point of normalised box coordinates (s, t, u). */
function pointAt(law: LatticeLaw, s: number, t: number, u: number): Vec3 {
  return fromBoxCoordinates(law, [
    law.box.min[0] + s * (law.box.max[0] - law.box.min[0]),
    law.box.min[1] + t * (law.box.max[1] - law.box.min[1]),
    law.box.min[2] + u * (law.box.max[2] - law.box.min[2]),
  ]);
}

interface PatchBound {
  readonly min: number;
  readonly max: number;
  readonly sampledMin: number;
  readonly sampledMax: number;
  readonly minNode: Vec3;
  readonly maxNode: Vec3;
}

/**
 * Bernstein-coefficient bound of det J over the patch `low`..`high` (normalised coordinates) where it is a polynomial of degrees `degrees`: sampled at the nodes
 * of that degree, converted to Bernstein coefficients, whose extremes bound it.
 */
function patchBound(law: LatticeLaw, low: Vec3, high: Vec3, degrees: Vec3): PatchBound {
  const [dx, dy, dz] = degrees;
  const at = (s: number, t: number, u: number): Vec3 => [
    low[0] + s * (high[0] - low[0]),
    low[1] + t * (high[1] - low[1]),
    low[2] + u * (high[2] - low[2]),
  ];
  const values = new Float64Array((dx + 1) * (dy + 1) * (dz + 1));
  let sampledMin = Infinity;
  let sampledMax = -Infinity;
  let minNode: Vec3 = [0, 0, 0];
  let maxNode: Vec3 = [0, 0, 0];
  for (let i = 0; i <= dx; i++)
    for (let j = 0; j <= dy; j++)
      for (let k = 0; k <= dz; k++) {
        const value = determinantAtNormalised(law, at(i / dx, j / dy, k / dz));
        values[(i * (dy + 1) + j) * (dz + 1) + k] = value;
        const node: Vec3 = [
          low[0] + (i / dx) * (high[0] - low[0]),
          low[1] + (j / dy) * (high[1] - low[1]),
          low[2] + (k / dz) * (high[2] - low[2]),
        ];
        if (value < sampledMin) {
          sampledMin = value;
          minNode = node;
        }
        if (value > sampledMax) {
          sampledMax = value;
          maxNode = node;
        }
      }
  // values at the nodes -> Bernstein coefficients, one axis at a time
  const apply = (grid: Float64Array, axis: 0 | 1 | 2): Float64Array => {
    const inverse = bernsteinInverse(degrees[axis]);
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
  let min = Infinity;
  let max = -Infinity;
  for (const value of coefficients) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max, sampledMin, sampledMax, minNode, maxNode };
}

/** Knot breakpoints of one axis in normalised coordinates: the ends of the knot spans of a B-spline axis, [0, 1] for a Bernstein one. */
function breakpoints(law: LatticeLaw, axis: 0 | 1 | 2): number[] {
  const p = law.splineDegrees?.[axis];
  if (p === undefined) return [0, 1];
  const count = law.degrees[axis] + 1;
  return Array.from({ length: count - p + 1 }, (_, i) => i / (count - p));
}

/**
 * Range of det J over the box. For a Bernstein lattice det J is a polynomial of degree 3l - 1, 3m - 1, 3n - 1 in (s, t, u): it is bounded by the Bernstein
 * coefficients over the whole box (Sederberg & Parry: "the largest and smallest coefficients bound the volume change") and its extremes are polished from a dense grid.
 * A B-spline lattice is a polynomial of degree 3p - 1 on each knot span: the bound is the extremes over the spans, the sampled values those of their nodes.
 */
export function determinantBounds(law: LatticeLaw): DeterminantBounds {
  const { splineDegrees } = law;
  if (splineDegrees !== undefined) {
    const marks = AXES.map((a) => breakpoints(law, a));
    const degrees = splineDegrees.map((p) => 3 * p - 1) as unknown as Vec3;
    let boundMin = Infinity;
    let boundMax = -Infinity;
    let sampledMin = Infinity;
    let sampledMax = -Infinity;
    let minNode: Vec3 = [0, 0, 0];
    let maxNode: Vec3 = [0, 0, 0];
    const [mx, my, mz] = marks as [number[], number[], number[]];
    for (let i = 0; i + 1 < mx.length; i++)
      for (let j = 0; j + 1 < my.length; j++)
        for (let k = 0; k + 1 < mz.length; k++) {
          const patch = patchBound(
            law,
            [mx[i] as number, my[j] as number, mz[k] as number],
            [mx[i + 1] as number, my[j + 1] as number, mz[k + 1] as number],
            degrees,
          );
          boundMin = Math.min(boundMin, patch.min);
          boundMax = Math.max(boundMax, patch.max);
          if (patch.sampledMin < sampledMin) {
            sampledMin = patch.sampledMin;
            minNode = patch.minNode;
          }
          if (patch.sampledMax > sampledMax) {
            sampledMax = patch.sampledMax;
            maxNode = patch.maxNode;
          }
          // the nodes of the interpolation are not where a polynomial peaks: a denser grid inside the span too
          const [lo, hi] = [[mx[i], my[j], mz[k]] as Vec3, [mx[i + 1], my[j + 1], mz[k + 1]] as Vec3];
          for (let a = 0; a < SPAN_GRID; a++)
            for (let b = 0; b < SPAN_GRID; b++)
              for (let c = 0; c < SPAN_GRID; c++) {
                const s: Vec3 = [
                  (lo[0] as number) + (((hi[0] as number) - (lo[0] as number)) * a) / (SPAN_GRID - 1),
                  (lo[1] as number) + (((hi[1] as number) - (lo[1] as number)) * b) / (SPAN_GRID - 1),
                  (lo[2] as number) + (((hi[2] as number) - (lo[2] as number)) * c) / (SPAN_GRID - 1),
                ];
                const value = determinantAtNormalised(law, s);
                if (value < sampledMin) {
                  sampledMin = value;
                  minNode = s;
                }
                if (value > sampledMax) {
                  sampledMax = value;
                  maxNode = s;
                }
              }
        }
    const stepSize = 0.5 / (SPAN_GRID * Math.max(...marks.map((m) => m.length - 1)));
    const atNode = (s: Vec3): number => determinantAtNormalised(law, s);
    const lowest = polish(atNode, minNode, stepSize, 1);
    const highest = polish(atNode, maxNode, stepSize, -1);
    sampledMin = Math.min(sampledMin, lowest.value);
    sampledMax = Math.max(sampledMax, highest.value);
    return { boundMin, boundMax, sampledMin, sampledMax, sampledMinAt: pointAt(law, lowest.at[0], lowest.at[1], lowest.at[2]) };
  }
  const degrees = law.degrees.map((degree) => 3 * degree - 1) as unknown as Vec3;
  const whole = patchBound(law, [0, 0, 0], [1, 1, 1], degrees);
  let { sampledMin, sampledMax } = whole;
  let minNode = whole.minNode;
  let maxNode = whole.maxNode;
  // a denser grid (the nodes of the interpolation are not where a polynomial peaks), then a local search from the best points of both
  const dense = (axisDegree: number): number => Math.min(GRID_CAP, 6 * axisDegree + 1);
  const [gx, gy, gz] = [dense(degrees[0]), dense(degrees[1]), dense(degrees[2])];
  const determinantAt = (s: Vec3): number => determinantAtNormalised(law, s);
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
  const sampledMinAt = pointAt(law, lowest.at[0], lowest.at[1], lowest.at[2]);
  return { boundMin: whole.min, boundMax: whole.max, sampledMin, sampledMax, sampledMinAt };
}
