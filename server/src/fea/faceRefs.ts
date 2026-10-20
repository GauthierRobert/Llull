/**
 * Kernel B-rep faces of an analysed part for the face map (TR-FEA-32): area and centroid of every face (`GeometryKernel.faceQuery.faceDetails`) so the mesher can
 * match them to its surfaces by geometry, and the kernel face index nearest to each `facesNear` point so a target resolves by face id. A kernel without a face
 * query (Manifold) or a part it cannot evaluate gives `null`: the mesher then resolves targets by the nearest surface, as before.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { operandRecipe } from '@core/commands/brep/kernelShape';
import { is3D, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';

interface FaceRef {
  readonly index: number;
  readonly area: number;
  readonly centroid: Vec3;
}

export interface PartFaces {
  readonly faces: readonly FaceRef[];
  /** Kernel face index nearest to each point (document units) when it lies within `1e-3` of the model diagonal of it, else null for that point. */
  readonly nearest: (points: readonly Vec3[]) => readonly (number | null)[];
}

/** A point farther than this fraction of the part's diagonal from every face is unresolved (the mesher reports it). */
const NEAR_REL = 1e-3;

/** @failure missing / 2D entity, no kernel, no face query, a kernel that cannot answer -> null (nothing is thrown) */
export function partFaces(doc: CadDocument, entityId: string, kernel: GeometryKernel | null): PartFaces | null {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  const query = kernel?.faceQuery;
  if (kernel === null || query === undefined || entity === undefined || !is3D(entity)) return null;
  const shape = kernel.evaluate(operandRecipe(kernel, entity));
  if (shape === null) return null;
  const details = query.faceDetails(shape, { samples: 8 });
  if (details === null || details.length === 0) return null;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const detail of details)
    for (const point of [detail.centroid, ...detail.samples])
      for (const axis of [0, 1, 2] as const) {
        lo[axis] = Math.min(lo[axis], point[axis]);
        hi[axis] = Math.max(hi[axis], point[axis]);
      }
  const diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  return {
    faces: details.map((detail) => ({ index: detail.index, area: detail.area, centroid: detail.centroid })),
    nearest: (points) => {
      const found = points.length === 0 ? [] : query.distance(shape, points);
      return points.map((_point, at) => {
        const hit = found?.[at];
        return hit === undefined || hit === null || !(Math.abs(hit.distance) <= NEAR_REL * diagonal) ? null : hit.face;
      });
    },
  };
}
