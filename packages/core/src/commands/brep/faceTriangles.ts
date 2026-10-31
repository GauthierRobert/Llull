/** inspect_face_triangles: which B-rep face each display triangle belongs to, so a viewport highlights exactly the face the kernel names (04 DIR M-UI). */

import { entityToTriangles } from '../../geometry/entityTriangles';
import { operandRecipe } from '../../geometry/operandRecipe';
import { type CadDocument, is3D } from '../../model/types';
import { defineCommand, z } from '../schema';
import { commandError, rejection, report } from '../noop';
import type { CommandResult } from '../types';
import { currentContext } from '../context';

/** More triangles than this are refused: the label list would be heavier than the highlight it serves. */
export const MAX_LABELLED_TRIANGLES = 200000;
const OCC_HINT = 'the native llull-kernel (OCCT)';

const refuse = (doc: CadDocument, id: string, code: string, why: string, remediation: string): CommandResult =>
  rejection(doc, `inspect_face_triangles: ${why}; no-op.`, commandError(code, remediation, [id]));

/**
 * @affects nothing — read-only
 * @invariant data = { entityId, faceCount, triangleCount, faceOfTriangle[] }: `faceOfTriangle[t]` is the face index (the one of inspect_topology / inspect_faces) nearest the centroid of display triangle t, in the triangle order of the viewport (`entityToTriangles`); a tessellation triangle never straddles two faces
 * @failure missing id, not a 3D solid, no exact kernel with face queries (KRN_NO_EXACT_KERNEL), unbuildable solid (KRN_SHAPE_UNAVAILABLE), more than MAX_LABELLED_TRIANGLES (KRN_TRIANGLE_LIMIT), kernel unable to answer (KRN_FACE_QUERY_FAILED) -> rejected no-op, no data
 */
export const inspectFaceTriangles = defineCommand({
  name: 'inspect_face_triangles',
  annotations: { readsMeshTriangles: true, readOnly: true, requiresKernel: true },
  description:
    'For an exact 3D solid, the B-rep face of every display triangle: data.faceOfTriangle[t] is the index (as in inspect_topology / inspect_faces) of the face that triangle t of the viewport tessellation lies on, ' +
    'data.faceCount the number of faces. Use it to highlight or pick a whole face (a bore wall, a fillet, a planar face with a hole) without guessing from the mesh. ' +
    `Needs the exact kernel (${OCC_HINT}); refused without it (KRN_NO_EXACT_KERNEL) and above ${MAX_LABELLED_TRIANGLES} triangles (KRN_TRIANGLE_LIMIT). Does not modify the document.`,
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid entity (a primitive, or a boolean / fillet / chamfer / shell result).'),
  }),
  run: (doc, { entityId }, ctx): CommandResult => {
    const entity = doc.entities[entityId];
    if (!entity) return refuse(doc, entityId, 'ENTITY_NOT_FOUND', `entity '${entityId}' not found`, 'Pass an existing 3D solid id.');
    if (!is3D(entity) || entity.kind === 'instance')
      return refuse(
        doc,
        entityId,
        'ENTITY_NOT_SOLID',
        `entity '${entityId}' (kind '${entity.kind}') is not a 3D solid`,
        'Pass a 3D solid; explode instances first.',
      );
    const kernel = (ctx ?? currentContext()).kernel;
    const port = kernel?.faceQuery;
    if (!kernel || !port)
      return refuse(
        doc,
        entityId,
        'KRN_NO_EXACT_KERNEL',
        `no exact kernel with face queries is available; use ${OCC_HINT}`,
        `Start with ${OCC_HINT}.`,
      );
    const triangles = entityToTriangles(entity, doc);
    if (triangles.length > MAX_LABELLED_TRIANGLES)
      return refuse(
        doc,
        entityId,
        'KRN_TRIANGLE_LIMIT',
        `'${entityId}' has ${triangles.length} display triangles (limit ${MAX_LABELLED_TRIANGLES})`,
        'Pick on a coarser body; the viewport falls back to its mesh heuristic.',
      );
    const shape = kernel.evaluate(operandRecipe(kernel, entity));
    if (shape === null)
      return refuse(
        doc,
        entityId,
        'KRN_SHAPE_UNAVAILABLE',
        `the kernel could not build entity '${entityId}' (kind '${entity.kind}')`,
        'Check the solid with inspect_topology.',
      );
    const centroids = triangles.map(
      (t) => [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3] as const,
    );
    const nearest = port.distance(shape, centroids);
    const faceCount = port.faceDetails(shape, { samples: 0 })?.length ?? null;
    if (nearest === null || nearest.length !== centroids.length || faceCount === null)
      return refuse(
        doc,
        entityId,
        'KRN_FACE_QUERY_FAILED',
        'the kernel could not label the triangles of this shape',
        'Retry; check the solid is valid.',
      );
    return report(doc, `inspect_face_triangles: '${entityId}' has ${faceCount} faces over ${triangles.length} triangles.`, {
      entityId,
      faceCount,
      triangleCount: triangles.length,
      faceOfTriangle: nearest.map((hit) => hit.face),
    });
  },
});
