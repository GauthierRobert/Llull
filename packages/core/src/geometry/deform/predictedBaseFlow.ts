/**
 * Predicted volume of a flow along a curve with a base curve (01 DEF §17.2), independent of the deformed surface. In base coordinates (arc length s, offsets
 * x, y in the base frame) the source volume element is (1 - kb·o) ds dx dy and the map multiplies it by ratio (1 - kt·o) / (1 - kb·o), kb and kt the curvatures
 * of the base and of the target at the matching arc length (T' = k1 N + k2 B), so ∫ det J dV = ∫ ratio (A(s) - kt1 Mx(s) - kt2 My(s)) ds with A, Mx, My the
 * area and first moments of the section of the body by the plane through the base point P(s) normal to T(s).
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { dot3, sub3 } from '../../lib/vec3';
import { orientOutward, signedMeshVolume } from '../meshVolume';
import { baseFrameAt, frameCurvatures, projectOnBase } from './flow';
import { resolveFrame, toLocal } from './frame';
import type { DeformNode } from './laws';
import { type PredictedVolume, sectionAt } from './predictedVolume';

/** Sections per piece: sub-intervals x 3 Gauss points. */
const SUBINTERVALS = 24;
const GAUSS_NODES = [0.5 - Math.sqrt(0.15), 0.5, 0.5 + Math.sqrt(0.15)];
const GAUSS_WEIGHTS = [5 / 18, 8 / 18, 5 / 18];

/** Cap on vertices x sections (keeps the check fast on large meshes). */
const WORK_LIMIT = 6e7;

/**
 * ∫ det J dV of the flow `node` (its law has a base) over the closed mesh `source`.
 * @failure degenerate frame, empty mesh, or a law without a base -> null
 */
export function predictedBaseFlowVolume(source: MeshData, node: Pick<DeformNode, 'law' | 'frame'>): PredictedVolume | null {
  const { law } = node;
  const frame = resolveFrame(node.frame);
  if (law.kind !== 'flowCurve' || law.base === undefined || frame === null || source.indices.length === 0) return null;
  const base = law.base;
  const indices = orientOutward(source.positions, source.indices);
  const volume = signedMeshVolume(source.positions, indices);
  const count = source.positions.length / 3;
  const points: Vec3[] = [];
  for (let v = 0; v < count; v++)
    points.push(
      toLocal(frame, [source.positions[v * 3] as number, source.positions[v * 3 + 1] as number, source.positions[v * 3 + 2] as number]),
    );
  const arcs = points.map((q) => projectOnBase(base, q));
  const [from, to] = [Math.min(...arcs), Math.max(...arcs)];
  // a base turning more than half a turn: the normal plane at s also cuts the far part of the body, whose vertices project elsewhere; only triangles
  // whose projected arc lengths bracket s are in the section
  const arcSpans = new Float64Array((indices.length / 3) * 2);
  for (let t = 0; t < indices.length / 3; t++) {
    const own = [0, 1, 2].map((k) => arcs[indices[t * 3 + k] as number] as number);
    arcSpans[t * 2] = Math.min(...own);
    arcSpans[t * 2 + 1] = Math.max(...own);
  }
  const triangles = indices.length / 3;
  const perPiece = Math.max(2, Math.min(SUBINTERVALS, Math.floor(WORK_LIMIT / (count * 3 + triangles * 3))));
  const width = (to - from) / perPiece;
  const local = new Float64Array(count * 3);
  const heights = new Float64Array(count);
  const spans = new Float64Array(triangles * 2);
  let predicted = 0;
  for (let sub = 0; sub < perPiece; sub++)
    for (let g = 0; g < 3; g++) {
      const s = from + (sub + (GAUSS_NODES[g] as number)) * width;
      const own = baseFrameAt(base, s);
      for (let v = 0; v < count; v++) {
        const gap = sub3(points[v] as Vec3, own.point);
        local.set([dot3(gap, own.n), dot3(gap, own.b), dot3(gap, own.t)], v * 3);
        heights[v] = local[v * 3 + 2] as number;
      }
      for (let t = 0; t < triangles; t++) {
        const hs = [0, 1, 2].map((k) => heights[indices[t * 3 + k] as number] as number);
        const brackets = (arcSpans[t * 2] as number) <= s && s <= (arcSpans[t * 2 + 1] as number);
        spans[t * 2] = brackets ? Math.min(...hs) : Infinity;
        spans[t * 2 + 1] = brackets ? Math.max(...hs) : Infinity;
      }
      const section = sectionAt(local, indices, heights, spans, 0);
      const target = frameCurvatures(law, law.ratio * (s - law.z0));
      predicted +=
        (GAUSS_WEIGHTS[g] as number) * width * law.ratio * (section.area - target.k1 * section.momentX - target.k2 * section.moment);
    }
  return { source: volume, predicted };
}
