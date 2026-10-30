/**
 * Predicted volume of a deformed body, independent of the deformed surface (01 DEF §5.10): ∫ det J dV over the SOURCE solid. det J depends on the
 * height z (and linearly on y for the bend), so the integral is ∫ [d(z) A(z) + d'(z) My(z)] dz with A and My the area and first moment of the
 * source cross-section, taken from the closed source triangles by Green's theorem; the heights are integrated piecewise between the region ends
 * (where det J jumps) with Gauss–Legendre.
 * @invariant exact for affine, twist and stretch; converges for taper and bend (smooth integrand between the region ends)
 */

import type { DeformRegion } from '../../model/deform';
import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { type DeformNode, determinant, localDeterminant, warpOf } from './laws';
import { orientOutward, signedMeshVolume } from '../meshVolume';
import { toLocal } from './frame';

/** Heights integrated per piece: sub-intervals × 3 Gauss points. */
const SUBINTERVALS = 24;
const GAUSS_NODES = [0.5 - Math.sqrt(0.15), 0.5, 0.5 + Math.sqrt(0.15)];
const GAUSS_WEIGHTS = [5 / 18, 8 / 18, 5 / 18];

/** Laws whose det J is linear in the cross-section coordinates (x, y) at every height z. */
const SECTION_LAWS: ReadonlySet<string> = new Set(['twist', 'taper', 'stretch', 'bend', 'flowCurve']);

/** Placeholder region of a law that has none (the law ignores it). */
const WHOLE_AXIS: DeformRegion = { start: -Infinity, end: Infinity, falloff: 'none', beyond: 'rigid' };

/** Cap on triangle × slice tests (keeps the check fast on large meshes). */
const WORK_LIMIT = 4e7;

interface Slice {
  readonly area: number;
  /** ∫ y dA and ∫ x dA of the section. */
  readonly moment: number;
  readonly momentX: number;
}

/** Area and ∫ y dA of the section of an outward-wound closed mesh by the plane z = ζ (local coordinates), by Green's theorem over oriented segments. */
function sectionAt(local: Float64Array, indices: ReadonlyArray<number>, heights: Float64Array, spans: Float64Array, zeta: number): Slice {
  let area = 0;
  let moment = 0;
  let momentX = 0;
  for (let t = 0; t < indices.length / 3; t++) {
    if ((spans[t * 2] as number) > zeta || (spans[t * 2 + 1] as number) <= zeta) continue;
    const corners = [indices[t * 3] as number, indices[t * 3 + 1] as number, indices[t * 3 + 2] as number];
    const below = corners.map((c) => (heights[c] as number) <= zeta);
    if (below.every(Boolean) || !below.some(Boolean)) continue;
    const points: Vec3[] = [];
    for (let k = 0; k < 3; k++) {
      const [i, j] = [corners[k] as number, corners[(k + 1) % 3] as number];
      if (below[k] === below[(k + 1) % 3]) continue;
      const s = (zeta - (heights[i] as number)) / ((heights[j] as number) - (heights[i] as number));
      const [pi, pj] = [i * 3, j * 3];
      points.push([
        (local[pi] as number) + s * ((local[pj] as number) - (local[pi] as number)),
        (local[pi + 1] as number) + s * ((local[pj + 1] as number) - (local[pi + 1] as number)),
        zeta,
      ]);
    }
    const [p, q] = points as [Vec3, Vec3];
    const [a, b, c] = corners.map((corner) => [local[corner * 3], local[corner * 3 + 1], local[corner * 3 + 2]] as unknown as Vec3) as [
      Vec3,
      Vec3,
      Vec3,
    ];
    const normal = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    ];
    // tangent of the counter-clockwise section boundary = ẑ × n = (−ny, nx)
    const forward = (q[0] - p[0]) * -(normal[1] as number) + (q[1] - p[1]) * (normal[0] as number) >= 0;
    const [from, to] = forward ? [p, q] : [q, p];
    const cross = from[0] * to[1] - to[0] * from[1];
    area += cross / 2;
    moment += ((from[1] + to[1]) * cross) / 6;
    momentX += ((from[0] + to[0]) * cross) / 6;
  }
  return { area, moment, momentX };
}

export interface PredictedVolume {
  /** Volume of the source mesh (outward-oriented), document units³. */
  readonly source: number;
  /** ∫ det J dV over the source mesh. */
  readonly predicted: number;
}

/**
 * ∫ det J dV of `node`'s map over the closed triangle mesh `source` (any winding; oriented outward here).
 * @failure degenerate frame or empty mesh -> null
 */
export function predictedVolume(source: MeshData, node: Pick<DeformNode, 'law' | 'frame' | 'region'>): PredictedVolume | null {
  const warp = warpOf(node);
  if (warp === null || source.indices.length === 0) return null;
  const indices = orientOutward(source.positions, source.indices);
  const volume = signedMeshVolume(source.positions, indices);
  if (node.law.kind === 'affine') return { source: volume, predicted: Math.abs(determinant(node.law.matrix)) * volume };
  // a flow has no region: its det J is linear in x and y at every height, so the cross-section integral applies over the whole body
  const region = node.region ?? (node.law.kind === 'flowCurve' ? WHOLE_AXIS : undefined);
  if (region === undefined || !SECTION_LAWS.has(node.law.kind)) return null;
  const vertexCount = source.positions.length / 3;
  const local = new Float64Array(vertexCount * 3);
  const heights = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const q = toLocal(warp.frame, [
      source.positions[v * 3] as number,
      source.positions[v * 3 + 1] as number,
      source.positions[v * 3 + 2] as number,
    ]);
    local.set(q, v * 3);
    heights[v] = q[2];
  }
  const triangles = indices.length / 3;
  const spans = new Float64Array(triangles * 2);
  for (let t = 0; t < triangles; t++) {
    const zs = [0, 1, 2].map((k) => heights[indices[t * 3 + k] as number] as number);
    spans[t * 2] = Math.min(...zs);
    spans[t * 2 + 1] = Math.max(...zs);
  }
  let low = Infinity;
  let high = -Infinity;
  for (const z of heights) {
    if (z < low) low = z;
    if (z > high) high = z;
  }
  const breaks = [
    low,
    ...(node.region === undefined || node.region.infinite === true ? [] : [region.start, region.end].filter((z) => z > low && z < high)),
    high,
  ];
  const perPiece = Math.max(2, Math.min(SUBINTERVALS, Math.floor(WORK_LIMIT / (triangles * 3 * Math.max(1, breaks.length - 1)))));
  let predicted = 0;
  for (let piece = 0; piece + 1 < breaks.length; piece++) {
    const [from, to] = [breaks[piece] as number, breaks[piece + 1] as number];
    const width = (to - from) / perPiece;
    for (let sub = 0; sub < perPiece; sub++) {
      for (let g = 0; g < 3; g++) {
        const zeta = from + (sub + (GAUSS_NODES[g] as number)) * width;
        const section = sectionAt(local, indices, heights, spans, zeta);
        const d0 = localDeterminant(node.law, region, [0, 0, zeta]);
        const slope = localDeterminant(node.law, region, [0, 1, zeta]) - d0;
        const slopeX = localDeterminant(node.law, region, [1, 0, zeta]) - d0;
        predicted += (GAUSS_WEIGHTS[g] as number) * width * (d0 * section.area + slope * section.moment + slopeX * section.momentX);
      }
    }
  }
  return { source: volume, predicted };
}
