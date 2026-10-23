/** field_from_solid: the signed distance of an existing closed solid as a field node (05 IMP 4.1, 5.9). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import type { SolidNode } from './model';
import { addNode } from './nodeResult';
import { closedSolidMesh } from './solidMesh';

/**
 * @affects creates 1 solid node that references the entity (it is not copied, not hidden, not changed)
 * @invariant distance is exact to the entity's stored triangles (a B-rep solid differs from its true distance by at most the tessellation deflection); sign by the generalised winding number; an imported mesh without a pinned source hash makes every result built on it `unverified`
 * @failure unknown id -> IMP_ENTITY_NOT_FOUND; 2D shape, curve, sheet, or a mesh with free edges -> IMP_SOLID_NOT_CLOSED
 */
export const fieldFromSolid = defineCommand({
  name: 'field_from_solid',
  annotations: { readsMeshTriangles: true },
  description:
    'Turn an existing CLOSED 3D solid (box, cylinder, extrusion, boolean result, imported mesh...) into an implicit FIELD whose negative side is the solid, so it can be shelled, offset, blended or filled with a lattice. ' +
    "The distance is exact to the solid's stored triangles; for curved or B-rep sources it is reported as a distance bound (data.tessellationExact false). Refused for 2D shapes, curves, sheets and meshes with free edges (IMP_SOLID_NOT_CLOSED). The solid itself is left untouched; hide it with create_implicit_body hideSource when the realised body replaces it.",
  params: z.object({
    entityId: z.string().describe('Id of the closed 3D solid entity.'),
    name: z.string().optional().describe('Optional label for the field node.'),
  }),
  run: (doc, { entityId, name }): CommandResult => {
    const node: SolidNode = { id: nextId('fld'), op: 'solid', entityId, ...(name === undefined ? {} : { name }) };
    const solid = closedSolidMesh(doc, entityId);
    const exact = solid.ok && solid.exactTessellation;
    return addNode(doc, 'field_from_solid', node, `signed distance of '${entityId}'`, {
      entityId,
      tessellationExact: exact,
      deflection: null,
      deflectionNote: exact
        ? 'planar faces: the triangles are the solid'
        : 'curved or B-rep source: the distance is exact to the stored tessellation only (its deflection is not recorded), reported as a bound',
    });
  },
});
