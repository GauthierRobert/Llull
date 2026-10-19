/** Mesh adequacy (05 §5.5, VC-FEA-09): is the mesh fine enough across the thinnest dimension of each part for a linear / quadratic tet to resolve bending? */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { distance3 } from '@lib/vec3';

export interface PartAdequacy {
  readonly entityId: string;
  /** Smallest side of the part's axis-aligned bounding box, in analysis length units. */
  readonly thinnestExtent: number;
  /** Mean corner-node edge length of the part's tetrahedra. */
  readonly meanEdge: number;
  /** `thinnestExtent / meanEdge`: about how many element edges fit across the thinnest dimension. */
  readonly elementsAcross: number;
}

/** Fewer element edges than this across the thinnest dimension raises FEA_MESH_ADEQUACY (the CalculiX simplebeam example is 10 % stiff with 1 element). */
export const MIN_ELEMENTS_ACROSS = 2;

/**
 * Elements across the thinnest dimension of every meshed part (bounding box over mean tet edge: a heuristic for the through-thickness / span
 * count, exact for a structured block).
 * @invariant parts without elements are omitted
 */
export function partAdequacy(mesh: FeMeshArtifact): PartAdequacy[] {
  const coordinates = new Map<number, Vec3>(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]]]));
  const out: PartAdequacy[] = [];
  for (const entityId of new Set(mesh.blocks.map((block) => block.entityId))) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let total = 0;
    let edges = 0;
    for (const block of mesh.blocks.filter((candidate) => candidate.entityId === entityId))
      for (const element of block.elements) {
        const corners = element.slice(1, 5).map((id) => coordinates.get(id));
        if (corners.some((corner) => corner === undefined) || corners.length < 4) continue;
        const points = corners as Vec3[];
        points.forEach((point, index) => {
          point.forEach((value, axis) => {
            lo[axis] = Math.min(lo[axis] ?? Infinity, value);
            hi[axis] = Math.max(hi[axis] ?? -Infinity, value);
          });
          for (const other of points.slice(index + 1)) {
            total += distance3(point, other);
            edges++;
          }
        });
      }
    if (edges === 0) continue;
    const thinnest = Math.min(...hi.map((high, axis) => high - (lo[axis] ?? 0)));
    const meanEdge = total / edges;
    out.push({
      entityId,
      thinnestExtent: thinnest,
      meanEdge,
      elementsAcross: meanEdge > 0 ? thinnest / meanEdge : Number.MAX_SAFE_INTEGER,
    });
  }
  return out;
}
