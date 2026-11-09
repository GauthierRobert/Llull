/** Resolution of the `facesNear` points of an exposure to face indices of the exact solid (the kernel's exact face distance). */

import { boundsExtent, entityBoundsInDoc } from '@core/geometry/bounds';
import type { GeometryKernel } from '@core/geometry/kernel';
import { operandRecipe } from '@core/geometry/operandRecipe';
import type { CadDocument, Entity, Vec3 } from '@core/model/types';

export type FaceResolution = { readonly faces: readonly number[] } | { readonly problem: string };

/**
 * Unique face indices (ascending) nearest to each point.
 * @invariant a point counts as on the solid within 1e-3 x its largest bounding-box extent + 1e-6 document units
 * @failure no face-query port, unbuildable solid, point off the solid, point on an edge / seam (the kernel answers no single face) -> { problem }
 */
export function facesNearPoints(doc: CadDocument, kernel: GeometryKernel, entity: Entity, points: readonly Vec3[]): FaceResolution {
  const port = kernel.faceQuery;
  if (port === undefined) return { problem: 'the kernel has no face-query port' };
  const shape = kernel.evaluate(operandRecipe(kernel, entity));
  if (shape === null) return { problem: `the kernel could not build entity '${entity.id}'` };
  const hits = port.distance(shape, points);
  if (hits === null) return { problem: 'the kernel could not compute the face distances' };
  const tolerance = 1e-3 * boundsExtent(entityBoundsInDoc(doc, entity)) + 1e-6;
  const faces = new Set<number>();
  for (const [index, point] of points.entries()) {
    const hit = hits[index];
    if (hit === undefined || !(hit.distance <= tolerance))
      return { problem: `point ${index} [${point.join(', ')}] is not on the solid (nearest face ${hit?.distance ?? 'unknown'} away)` };
    if (!Number.isInteger(hit.face) || hit.face < 0)
      return {
        problem: `point ${index} [${point.join(', ')}] lies on an edge or seam and names no single face: move it onto a face interior`,
      };
    faces.add(hit.face);
  }
  return { faces: [...faces].sort((a, b) => a - b) };
}
