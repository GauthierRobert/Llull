/**
 * Consistent nodal shares of a uniform body force on a tetrahedron (14 FLL-M2b post-solve reaction check): integral of N_i det J over the
 * element, as CalculiX integrates it (C3D4: one point; C3D10: the 4-point rule over the real 10-node geometry, so a curved quadratic element,
 * with its boundary mid nodes projected onto the surface, gets its own shares; a straight one gets -V/20 per corner and V/5 per mid node).
 */

import type { Vec3 } from '@core/model/vectors';

const A = 0.5854101966249685;
const B = 0.1381966011250105;
/** 4-point rule of the unit tetrahedron (degree 2), weight 1/24 each, in (xi, eta, zeta). */
const GAUSS: readonly Vec3[] = [
  [B, B, B],
  [A, B, B],
  [B, A, B],
  [B, B, A],
];
/** Mid-edge nodes 5..10 of C3D10 (CalculiX order): the corner pair (0-based) of each. */
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
];

/** dL_m / d(xi, eta, zeta): L1 = 1 - xi - eta - zeta, L2 = xi, L3 = eta, L4 = zeta. */
const DL: readonly Vec3[] = [
  [-1, -1, -1],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const at = (values: readonly number[], index: number): number => values[index] ?? 0;
const row = (rows: readonly Vec3[], index: number): Vec3 => rows[index] ?? [0, 0, 0];

/** Values and natural derivatives of the 10 quadratic shape functions at (xi, eta, zeta). */
function quadratic(point: Vec3): { readonly values: number[]; readonly derivatives: Vec3[] } {
  const L: readonly [number, number, number, number] = [1 - point[0] - point[1] - point[2], point[0], point[1], point[2]];
  const scaled = (k: number, factor: number): Vec3 => [row(DL, k)[0] * factor, row(DL, k)[1] * factor, row(DL, k)[2] * factor];
  const values = [...L.map((l) => l * (2 * l - 1)), ...EDGES.map(([i, j]) => 4 * at(L, i) * at(L, j))];
  const derivatives = [
    ...L.map((l, k) => scaled(k, 4 * l - 1)),
    ...EDGES.map(([i, j]): Vec3 => {
      const [di, dj] = [scaled(i, 4 * at(L, j)), scaled(j, 4 * at(L, i))];
      return [di[0] + dj[0], di[1] + dj[1], di[2] + dj[2]];
    }),
  ];
  return { values, derivatives };
}

/** det of the Jacobian sum_i x_i (x) dN_i/dxi (columns: d x / d xi, d x / d eta, d x / d zeta). */
function jacobian(nodes: readonly Vec3[], derivatives: readonly Vec3[]): number {
  const column = (c: 0 | 1 | 2): Vec3 =>
    nodes.reduce<Vec3>(
      (sum, x, i) => {
        const d = row(derivatives, i)[c];
        return [sum[0] + x[0] * d, sum[1] + x[1] * d, sum[2] + x[2] * d];
      },
      [0, 0, 0],
    );
  const [u, v, w] = [column(0), column(1), column(2)];
  return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
}

/**
 * integral of N_i |det J| per node of a C3D4 (4 nodes) or C3D10 (10 nodes, CalculiX order), or null for another element type / node count.
 * @invariant the shares sum to the element volume (the exact one for C3D4 and a straight C3D10; the 4-point one of a curved C3D10)
 */
export function bodyForceShares(type: string, nodes: readonly Vec3[]): number[] | null {
  if (type === 'C3D4' && nodes.length === 4) {
    const volume = Math.abs(jacobian(nodes, DL)) / 6;
    return [volume / 4, volume / 4, volume / 4, volume / 4];
  }
  if (type !== 'C3D10' || nodes.length !== 10) return null;
  const rules = GAUSS.map((point) => {
    const { values, derivatives } = quadratic(point);
    return { values, weight: Math.abs(jacobian(nodes, derivatives)) / 24 };
  });
  return nodes.map((_, i) => rules.reduce((sum, { values, weight }) => sum + at(values, i) * weight, 0));
}
