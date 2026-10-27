/**
 * Host-built jobs (CFD flow, topology optimization) read a document without going through `execute`, so nothing swaps the stored mesh in:
 * an asset-backed mesh there is its display level of detail unless the host handed over a full-resolution document (`withFullResolution`).
 * A pure builder must not run on it silently; it refuses by name (MESH_ASSET_LOD_ONLY).
 */

import type { CadDocument, Entity } from '../../model/types';
import { assetLeaves } from '../recipeLeaves';

/** True when the entity's own mesh, or a mesh leaf of its construction tree, is an asset-backed display level of detail. */
function holdsDisplayOnly(entity: Entity | undefined): boolean {
  if (entity?.kind !== 'mesh') return false;
  if (entity.asset !== undefined && entity.mesh.indices.length / 3 < entity.asset.triangles) return true;
  return entity.brep !== undefined && assetLeaves(entity.brep).some((leaf) => leaf.mesh.indices.length / 3 < leaf.asset.triangles);
}

/**
 * The entity ids among `ids` (and those inside the components of instances among them, nested ones included) whose mesh is an asset-backed
 * display level of detail (it has fewer triangles than its asset), or whose construction tree has such a mesh leaf.
 */
export function displayOnlyMeshIds(doc: Pick<CadDocument, 'entities' | 'components'>, ids: readonly string[]): string[] {
  const found = new Set<string>();
  const seenComponents = new Set<string>();
  const visitComponent = (componentId: string): void => {
    const component = Object.hasOwn(doc.components, componentId) ? doc.components[componentId] : undefined;
    if (component === undefined || seenComponents.has(componentId)) return;
    seenComponents.add(componentId);
    for (const [id, entity] of Object.entries(component.entities)) {
      if (entity.kind === 'instance') visitComponent(entity.componentId);
      else if (holdsDisplayOnly(entity)) found.add(id);
    }
  };
  for (const id of ids) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity?.kind === 'instance') visitComponent(entity.componentId);
    else if (holdsDisplayOnly(entity)) found.add(id);
  }
  return [...found];
}

/** The refusal text for `ids` (see `displayOnlyMeshIds`). */
export function displayOnlyMessage(ids: readonly string[]): string {
  return (
    `mesh asset(s) of ${ids.map((id) => `'${id}'`).join(', ')} are only held as a display level of detail in this document: ` +
    'a result computed from them would be wrong; the host must hand the builder a full-resolution document (withFullResolution)'
  );
}
