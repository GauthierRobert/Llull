/**
 * Full-resolution view of asset-backed meshes for a HOST path that reads a document without going through `execute` (the FEA mesher, a native exporter): nothing
 * swaps the stored mesh in there, so an asset-backed mesh would be its display level of detail (TECHNICAL_SPEC 13.21). The same reach and cap as the commands
 * (`meshReach`, `MESH_FULL_READ_TRIANGLE_CAP`), or a refusal by name: MESH_ASSET_TOO_LARGE, MESH_ASSET_LOD_ONLY.
 */

import { withFullResolution } from '../geometry/entityTriangles';
import { MESH_FULL_READ_TRIANGLE_CAP, type MeshAssetPort } from '../geometry/mesh/assets';
import { displayOnlyMeshIds } from '../geometry/mesh/displayOnly';
import type { CadDocument } from '../model/types';
import { reachedMeshes } from './meshReach';

export interface HostViewRefusal {
  readonly code: 'MESH_ASSET_TOO_LARGE' | 'MESH_ASSET_LOD_ONLY';
  readonly message: string;
  readonly ids: readonly string[];
}

/** The components an instance among `ids` stands for, nested instances included (what `withFullResolution` swaps for an instance). */
function componentsOfInstances(doc: CadDocument, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  const visit = (componentId: string): void => {
    const component = Object.hasOwn(doc.components, componentId) ? doc.components[componentId] : undefined;
    if (component === undefined || found.has(componentId)) return;
    found.add(componentId);
    for (const entity of Object.values(component.entities)) if (entity.kind === 'instance') visit(entity.componentId);
  };
  for (const id of ids) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity?.kind === 'instance') visit(entity.componentId);
  }
  return found;
}

/**
 * `doc` with every asset-backed mesh that `ids` reach (an entity, an instance's component, the leaves of a construction tree) at its stored triangles, or the refusal.
 * Only what the view swaps is counted against the cap and checked: a mesh that some other entity of `ids` merely names is not part of the answer.
 * @invariant a document that reaches no asset-backed mesh is returned as it is (same object); the reach is the one of the commands (`reachedMeshes`)
 * @failure the distinct assets reached hold more than MESH_FULL_READ_TRIANGLE_CAP triangles -> MESH_ASSET_TOO_LARGE; an asset this machine cannot read -> MESH_ASSET_LOD_ONLY
 */
export function fullResolutionView(
  doc: CadDocument,
  ids: readonly string[],
  assets: MeshAssetPort | null | undefined,
): CadDocument | HostViewRefusal {
  // only what the view swaps and the display-only check looks at is counted: the ids' own meshes (and construction-tree leaves), the components of their instances
  const components = componentsOfInstances(doc, ids);
  const wanted = reachedMeshes(doc, ids, false).filter((mesh) =>
    mesh.componentId === null ? ids.includes(mesh.id) : components.has(mesh.componentId),
  );
  if (wanted.length === 0) return doc;
  const keys = new Map(wanted.flatMap((mesh) => mesh.assets).map((asset) => [asset.key, asset.triangles]));
  const total = [...keys.values()].reduce((sum, triangles) => sum + triangles, 0);
  const owners = wanted.map((mesh) => mesh.id);
  if (total > MESH_FULL_READ_TRIANGLE_CAP)
    return {
      code: 'MESH_ASSET_TOO_LARGE',
      message:
        `the meshes ${owners.map((id) => `'${id}'`).join(', ')} hold ${total} full-resolution triangles in ${keys.size} asset(s), above the ` +
        `${MESH_FULL_READ_TRIANGLE_CAP} a host path may load; a result computed from the display level of detail would be wrong: name fewer parts, or decimate_mesh them first`,
      ids: owners,
    };
  const view = withFullResolution(doc, ids, assets);
  const lodOnly = displayOnlyMeshIds(view, ids);
  if (lodOnly.length > 0)
    return {
      code: 'MESH_ASSET_LOD_ONLY',
      message:
        `mesh asset(s) of ${lodOnly.map((id) => `'${id}'`).join(', ')} are only held as a display level of detail on this machine: a result computed from them ` +
        'would be wrong; run on the machine that imported the mesh, or re-import it with import_mesh_file / attach_mesh_asset',
      ids: lodOnly,
    };
  return view;
}
