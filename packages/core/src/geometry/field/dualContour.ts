/**
 * Dual contouring of a field on the node grid (05 IMP 5.7 item 6, M6; Ju, Losasso, Schaefer, Warren 2002): one vertex per cell that the surface crosses, at the
 * minimiser of the quadratic error of the Hermite data (edge crossings refined on the exact field, normals from the exact gradient), one quad per crossed
 * grid edge. Sharp features (box clips, strut ends, crease lines of min / max) keep their corners instead of being cut as the tetrahedra do.
 * @invariant the QEF is solved by the pseudo-inverse of the 3x3 normal matrix with eigenvalues below 0.1 of the largest dropped, minimising the distance to the mass point (S19); the vertex is clamped to its cell
 * @invariant the result is checked to be a closed edge-manifold mesh; `null` means "not manifold, use the tetrahedra" (dual contouring is not manifold in general)
 */

import type { IsoMesh } from '../../lib/isosurface/tetra';
import { isClosedManifold } from '../../lib/isosurface/measures';
import { evaluateWithGradient } from './gradient';
import { type PreparedProgram, evaluateAt } from './interpret';

export interface ContouredGrid {
  readonly nodes: readonly [number, number, number];
  readonly origin: readonly [number, number, number];
  readonly voxel: number;
  /** Node values, x fastest; < 0 is inside. */
  readonly values: Float64Array;
}

const SINGULAR_RATIO = 0.1;
const BISECTION_STEPS = 8;

interface Crossing {
  readonly p: [number, number, number];
  readonly n: [number, number, number];
}

const at = (m: ArrayLike<number>, i: number): number => m[i] as number;

/**
 * Eigen-decomposition of the symmetric 3x3 matrix `m` (row major) by cyclic Jacobi rotations: eigenvalues and the orthonormal eigenvectors as columns of `vectors`
 * (row major).
 */
function eigen3(m: Float64Array): { values: number[]; vectors: Float64Array } {
  const a = Float64Array.from(m);
  const v = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 24; sweep += 1) {
    if (Math.abs(at(a, 1)) + Math.abs(at(a, 2)) + Math.abs(at(a, 5)) < 1e-300) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = at(a, 3 * p + q);
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (at(a, 3 * q + q) - at(a, 3 * p + p)) / (2 * apq);
      const t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const [akp, akq] = [at(a, 3 * k + p), at(a, 3 * k + q)];
        a[3 * k + p] = c * akp - s * akq;
        a[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const [apk, aqk] = [at(a, 3 * p + k), at(a, 3 * q + k)];
        a[3 * p + k] = c * apk - s * aqk;
        a[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const [vkp, vkq] = [at(v, 3 * k + p), at(v, 3 * k + q)];
        v[3 * k + p] = c * vkp - s * vkq;
        v[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [at(a, 0), at(a, 4), at(a, 8)], vectors: v };
}

/** Minimiser of sum (n . (x - p))^2 near the mass point of the Hermite data, clamped to the box [lo, hi]. */
function solveQef(data: readonly Crossing[], lo: readonly number[], hi: readonly number[]): [number, number, number] {
  const mass = [0, 1, 2].map((axis) => data.reduce((sum, d) => sum + at(d.p, axis), 0) / data.length);
  const ata = new Float64Array(9);
  const atb = new Float64Array(3);
  for (const { p, n } of data) {
    const b = [0, 1, 2].reduce((sum, axis) => sum + at(n, axis) * (at(p, axis) - at(mass, axis)), 0);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) ata[3 * i + j] = at(ata, 3 * i + j) + at(n, i) * at(n, j);
      atb[i] = at(atb, i) + at(n, i) * b;
    }
  }
  const { values, vectors } = eigen3(ata);
  const largest = Math.max(...values.map(Math.abs), 1e-300);
  const shift = new Float64Array(3);
  for (let k = 0; k < 3; k += 1) {
    const lambda = at(values, k);
    if (Math.abs(lambda) < SINGULAR_RATIO * largest) continue;
    const projection = (at(vectors, k) * at(atb, 0) + at(vectors, 3 + k) * at(atb, 1) + at(vectors, 6 + k) * at(atb, 2)) / lambda;
    for (let axis = 0; axis < 3; axis += 1) shift[axis] = at(shift, axis) + projection * at(vectors, 3 * axis + k);
  }
  const clamped = [0, 1, 2].map((axis) => Math.min(at(hi, axis), Math.max(at(lo, axis), at(mass, axis) + at(shift, axis))));
  return [at(clamped, 0), at(clamped, 1), at(clamped, 2)];
}

/** Mesh of {values < 0} by dual contouring, or null when the result is not a closed edge-manifold surface. */
export function dualContour(prepared: PreparedProgram, grid: ContouredGrid, maxTriangles: number): IsoMesh | null {
  const [sx, sy, sz] = grid.nodes;
  if (sx < 3 || sy < 3 || sz < 3) return { positions: [], indices: [] };
  const { origin, voxel, values } = grid;
  const registers = new Float64Array(prepared.opcodes.length);
  const node = (i: number, j: number, k: number): number => i + sx * (j + sy * k);
  const inside = (id: number): boolean => (values[id] as number) < 0;
  const point = (i: number, j: number, k: number): [number, number, number] => [
    origin[0] + i * voxel,
    origin[1] + j * voxel,
    origin[2] + k * voxel,
  ];
  const crossings = new Map<number, Crossing>();

  /** Hermite datum of the grid edge leaving node (i, j, k) along `axis`, refined on the exact field. */
  const crossing = (i: number, j: number, k: number, axis: 0 | 1 | 2): Crossing => {
    const key = node(i, j, k) * 3 + axis;
    const known = crossings.get(key);
    if (known !== undefined) return known;
    const [ni, nj, nk] = [i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), k + (axis === 2 ? 1 : 0)];
    const a = point(i, j, k);
    const b = point(ni, nj, nk);
    const along = (t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const startInside = inside(node(i, j, k));
    let [lo, hi] = [0, 1];
    for (let step = 0; step < BISECTION_STEPS; step += 1) {
      const mid = (lo + hi) / 2;
      const [x, y, z] = along(mid);
      const value = evaluateAt(prepared, registers, x, y, z);
      if (Number.isFinite(value) && value < 0 === startInside) lo = mid;
      else hi = mid;
    }
    const p = along((lo + hi) / 2);
    const { gradient } = evaluateWithGradient(prepared, p[0], p[1], p[2]);
    const length = Math.hypot(gradient[0], gradient[1], gradient[2]);
    const fallback: [number, number, number] = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    const n: [number, number, number] =
      length > 1e-12 && Number.isFinite(length)
        ? [gradient[0] / length, gradient[1] / length, gradient[2] / length]
        : startInside
          ? fallback
          : (fallback.map((c) => -c) as [number, number, number]);
    const datum = { p, n };
    crossings.set(key, datum);
    return datum;
  };

  const cellVertex = new Map<number, number>();
  const positions: number[] = [];
  /** Vertex of cell (i, j, k), created on first use. */
  const vertexOf = (i: number, j: number, k: number): number => {
    const key = node(i, j, k);
    const known = cellVertex.get(key);
    if (known !== undefined) return known;
    const data: Crossing[] = [];
    for (let d1 = 0; d1 < 2; d1 += 1)
      for (let d2 = 0; d2 < 2; d2 += 1) {
        const edges: ReadonlyArray<readonly [number, number, number, 0 | 1 | 2]> = [
          [i, j + d1, k + d2, 0],
          [i + d1, j, k + d2, 1],
          [i + d1, j + d2, k, 2],
        ];
        for (const [ei, ej, ek, axis] of edges) {
          const far = node(ei + (axis === 0 ? 1 : 0), ej + (axis === 1 ? 1 : 0), ek + (axis === 2 ? 1 : 0));
          if (inside(node(ei, ej, ek)) !== inside(far)) data.push(crossing(ei, ej, ek, axis));
        }
      }
    const lo = point(i, j, k);
    const hi = point(i + 1, j + 1, k + 1);
    const p = solveQef(data, lo, hi);
    positions.push(p[0], p[1], p[2]);
    cellVertex.set(key, positions.length / 3 - 1);
    return positions.length / 3 - 1;
  };

  const indices: number[] = [];
  const dist = (a: number, b: number): number =>
    Math.hypot(
      (positions[3 * a] as number) - (positions[3 * b] as number),
      (positions[3 * a + 1] as number) - (positions[3 * b + 1] as number),
      (positions[3 * a + 2] as number) - (positions[3 * b + 2] as number),
    );
  /** Two triangles of the quad (a, b, c, d) around a crossed edge, oriented along the outward normal `n`, split on the shorter diagonal. */
  const quad = (a: number, b: number, c: number, d: number, n: readonly number[]): void => {
    const ring = dist(a, c) <= dist(b, d) ? [a, b, c, a, c, d] : [b, c, d, b, d, a];
    const [p, q, r] = [ring[0] as number, ring[1] as number, ring[2] as number];
    const [u0, u1, u2] = [0, 1, 2].map((axis) => (positions[3 * q + axis] as number) - (positions[3 * p + axis] as number)) as [
      number,
      number,
      number,
    ];
    const [w0, w1, w2] = [0, 1, 2].map((axis) => (positions[3 * r + axis] as number) - (positions[3 * p + axis] as number)) as [
      number,
      number,
      number,
    ];
    const flip = (u1 * w2 - u2 * w1) * at(n, 0) + (u2 * w0 - u0 * w2) * at(n, 1) + (u0 * w1 - u1 * w0) * at(n, 2) < 0;
    for (let t = 0; t < 6; t += 3) {
      const [x, y, z] = [ring[t] as number, ring[t + 1] as number, ring[t + 2] as number];
      if (x === y || y === z || x === z) continue;
      if (flip) indices.push(x, z, y);
      else indices.push(x, y, z);
    }
  };

  for (let k = 1; k < sz - 1; k += 1)
    for (let j = 1; j < sy - 1; j += 1)
      for (let i = 0; i < sx - 1; i += 1) {
        if (inside(node(i, j, k)) === inside(node(i + 1, j, k))) continue;
        const n = crossing(i, j, k, 0).n;
        quad(vertexOf(i, j - 1, k - 1), vertexOf(i, j, k - 1), vertexOf(i, j, k), vertexOf(i, j - 1, k), n);
      }
  for (let k = 1; k < sz - 1; k += 1)
    for (let j = 0; j < sy - 1; j += 1)
      for (let i = 1; i < sx - 1; i += 1) {
        if (inside(node(i, j, k)) === inside(node(i, j + 1, k))) continue;
        const n = crossing(i, j, k, 1).n;
        quad(vertexOf(i - 1, j, k - 1), vertexOf(i, j, k - 1), vertexOf(i, j, k), vertexOf(i - 1, j, k), n);
      }
  for (let k = 0; k < sz - 1; k += 1)
    for (let j = 1; j < sy - 1; j += 1)
      for (let i = 1; i < sx - 1; i += 1) {
        if (inside(node(i, j, k)) === inside(node(i, j, k + 1))) continue;
        const n = crossing(i, j, k, 2).n;
        quad(vertexOf(i - 1, j - 1, k), vertexOf(i, j - 1, k), vertexOf(i, j, k), vertexOf(i - 1, j, k), n);
      }
  if (indices.length / 3 > maxTriangles) return { positions, indices };
  const mesh = { positions, indices };
  return isClosedManifold(mesh) ? mesh : null;
}
