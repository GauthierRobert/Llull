/**
 * Where the triangles of an implicit body live (05 IMP D3, 07 MSH FR-MSH-02): inline in the entity up to MESH_INLINE_TRIANGLE_CAP, else in the host's
 * content-addressed mesh asset store with a display level of detail in the entity. A host without a store keeps the whole mesh inline (as before).
 * @invariant the asset key is the sha256 of the canonical mesh bytes, so the same realisation always lands on the same key and a stored mesh can stand in for re-evaluating the field
 */

import { type MeshAssetPort, MESH_INLINE_TRIANGLE_CAP, MESH_LOD_TRIANGLES } from '@core/geometry/mesh/assets';
import { lodMesh } from '@core/geometry/mesh/lod';
import type { MeshAssetRef } from '@core/model/meshProvenance';
import type { MeshData, MeshSolidEntity } from '@core/model/types';

export interface StoredBodyMesh {
  /** What the entity holds: the whole mesh, or its display level of detail. */
  readonly mesh: MeshData;
  readonly asset?: MeshAssetRef;
}

/** `mesh` as the entity should hold it, writing it to `assets` when it is above the inline cap. */
export function storeBodyMesh(mesh: MeshData, assets: MeshAssetPort | null | undefined): StoredBodyMesh {
  if (assets === null || assets === undefined || mesh.indices.length / 3 <= MESH_INLINE_TRIANGLE_CAP) return { mesh };
  return { mesh: lodMesh(mesh, MESH_LOD_TRIANGLES), asset: assets.writeMesh(mesh) };
}

/** The full-resolution mesh of a body entity, or null when its asset is not on this machine. */
export function fullBodyMesh(entity: MeshSolidEntity, assets: MeshAssetPort | null | undefined): MeshData | null {
  if (entity.asset === undefined) return entity.mesh;
  return assets?.readMesh(entity.asset.key) ?? null;
}
