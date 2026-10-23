/** The closed triangle mesh of a solid entity, for `field_from_solid` (05 IMP §5.9). */

import { entityToTriangles } from '@core/geometry/entityTriangles';
import { soupIndices } from '@core/geometry/meshVolume';
import { openEdgeCount } from '@core/geometry/meshClosure';
import type { CadDocument, MeshData } from '@core/model/types';

export type SolidMeshResult =
  | { readonly ok: true; readonly mesh: MeshData; readonly unpinned: boolean; readonly exactTessellation: boolean }
  | { readonly ok: false; readonly code: 'IMP_ENTITY_NOT_FOUND' | 'IMP_SOLID_NOT_CLOSED'; readonly message: string };

/** World-space triangles of `entityId` as a welded-by-position soup; refused when the entity is missing, has no triangles or has free edges. */
export function closedSolidMesh(doc: CadDocument, entityId: string): SolidMeshResult {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined) return { ok: false, code: 'IMP_ENTITY_NOT_FOUND', message: `no entity '${entityId}'` };
  const triangles = entityToTriangles(entity, doc);
  if (triangles.length === 0)
    return {
      ok: false,
      code: 'IMP_SOLID_NOT_CLOSED',
      message: `'${entityId}' (${entity.kind}) has no closed solid triangles: pick a 3D solid`,
    };
  const positions = triangles.flatMap((triangle) => triangle.flat());
  const mesh: MeshData = { positions, indices: soupIndices(positions) };
  const free = openEdgeCount(mesh, 0);
  if (free > 0) return { ok: false, code: 'IMP_SOLID_NOT_CLOSED', message: `'${entityId}' has ${free} free edge(s): the mesh is open` };
  const unpinned = entity.kind === 'mesh' && entity.meshSource !== undefined && !entity.meshSource.verified;
  const exactTessellation =
    entity.kind === 'box' || entity.kind === 'wedge' || entity.kind === 'pyramid' || (entity.kind === 'mesh' && entity.brep === undefined);
  return { ok: true, mesh, unpinned, exactTessellation };
}
