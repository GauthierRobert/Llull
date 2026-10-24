/**
 * Predicted volume by quadrature (01 DEF §5.10): ∫ det J dV over a closed source mesh as a signed fan of tetrahedra from its bounding-box centre, one
 * Gauss-Legendre product rule on the collapsed cube per tetrahedron (exact for polynomial integrands of moderate degree). Used for the laws whose det J has
 * no cross-section form (flow onto a surface).
 */

import type { DeformRegion } from '../../model/deform';
import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { type DeformNode, localDeterminant, warpOf } from './laws';
import { toLocal } from './frame';
import { orientOutward, signedMeshVolume } from '../meshVolume';
import type { PredictedVolume } from './predictedVolume';

const PLACEHOLDER: DeformRegion = { start: -Infinity, end: Infinity, falloff: 'none', beyond: 'rigid' };

/** Gauss-Legendre nodes and weights on [0, 1] for n = 2..5. */
const RULES: Readonly<Record<number, ReadonlyArray<readonly [number, number]>>> = {
  2: [
    [0.2113248654051871, 0.5],
    [0.7886751345948129, 0.5],
  ],
  3: [
    [0.1127016653792583, 5 / 18],
    [0.5, 8 / 18],
    [0.8872983346207417, 5 / 18],
  ],
  4: [
    [0.06943184420297371, 0.1739274225687269],
    [0.33000947820757187, 0.3260725774312731],
    [0.6699905217924281, 0.3260725774312731],
    [0.9305681557970262, 0.1739274225687269],
  ],
  5: [
    [0.04691007703066802, 0.11846344252809456],
    [0.23076534494715845, 0.23931433524968324],
    [0.5, 0.2844444444444444],
    [0.7692346550528415, 0.23931433524968324],
    [0.9530899229693319, 0.11846344252809456],
  ],
};

/** Law evaluations allowed in total (the work is triangles x n^3). */
const EVALUATION_BUDGET = 40_000;

/**
 * V and ∫ det J dV of the map over the closed triangle mesh `source`.
 * @failure degenerate frame or empty mesh -> null
 */
export function predictedVolumeByQuadrature(source: MeshData, node: Pick<DeformNode, 'law' | 'frame'>): PredictedVolume | null {
  const warp = warpOf({ ...node });
  if (warp === null || source.indices.length === 0) return null;
  const indices = orientOutward(source.positions, source.indices);
  const volume = signedMeshVolume(source.positions, indices);
  const triangles = indices.length / 3;
  const order = Math.min(5, Math.max(2, Math.floor(Math.cbrt(EVALUATION_BUDGET / triangles))));
  const rule = RULES[order] as ReadonlyArray<readonly [number, number]>;
  const local: Vec3[] = [];
  for (let v = 0; v < source.positions.length / 3; v++)
    local.push(
      toLocal(warp.frame, [
        source.positions[v * 3] as number,
        source.positions[v * 3 + 1] as number,
        source.positions[v * 3 + 2] as number,
      ]),
    );
  const centre = local.reduce<Vec3>(
    (sum, p) => [sum[0] + p[0] / local.length, sum[1] + p[1] / local.length, sum[2] + p[2] / local.length],
    [0, 0, 0],
  );
  let total = 0;
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [local[indices[3 * t] as number], local[indices[3 * t + 1] as number], local[indices[3 * t + 2] as number]] as [
      Vec3,
      Vec3,
      Vec3,
    ];
    const [e1, e2, e3] = [0, 1, 2].map((axis) => [
      (a[axis] as number) - centre[axis as 0],
      (b[axis] as number) - centre[axis as 0],
      (c[axis] as number) - centre[axis as 0],
    ]) as [number[], number[], number[]];
    // signed volume of the tetrahedron (centre, a, b, c): det [a - o, b - o, c - o] / 6
    const signed =
      ((e1[0] as number) * ((e2[1] as number) * (e3[2] as number) - (e2[2] as number) * (e3[1] as number)) -
        (e1[1] as number) * ((e2[0] as number) * (e3[2] as number) - (e2[2] as number) * (e3[0] as number)) +
        (e1[2] as number) * ((e2[0] as number) * (e3[1] as number) - (e2[1] as number) * (e3[0] as number))) /
      6;
    if (signed === 0) continue;
    let sum = 0;
    for (const [u, wu] of rule)
      for (const [v, wv] of rule)
        for (const [w, ww] of rule) {
          const [lu, lv, lw] = [u, (1 - u) * v, (1 - u) * (1 - v) * w];
          const point: Vec3 = [
            centre[0] + lu * (a[0] - centre[0]) + lv * (b[0] - centre[0]) + lw * (c[0] - centre[0]),
            centre[1] + lu * (a[1] - centre[1]) + lv * (b[1] - centre[1]) + lw * (c[1] - centre[1]),
            centre[2] + lu * (a[2] - centre[2]) + lv * (b[2] - centre[2]) + lw * (c[2] - centre[2]),
          ];
          sum += wu * wv * ww * (1 - u) * (1 - u) * (1 - v) * localDeterminant(node.law, PLACEHOLDER, point);
        }
    total += 6 * signed * sum;
  }
  return { source: volume, predicted: total };
}
