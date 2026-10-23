/**
 * Mesh asset port (07 MSH FR-MSH-02, TR-MSH-06): large meshes live in the host's content-addressed store, the document holds a reference and
 * a display level of detail. A pure command never writes a file: `writeMesh` is an idempotent cache write (same bytes, same key), like the
 * kernel's recipe cache, so replay recomputes the same key and the document stays a pure function of its inputs (D1).
 */

import type { MeshData } from '../../model/types';
import type { MeshAssetRef, MeshSource } from '../../model/meshProvenance';
import type { Vec3 } from '../../model/vectors';
import { applyEulerXYZ, isZeroRotation } from '../../lib/eulerRotation';

/** Triangles above which a mesh result lives in the asset store instead of the document (named, provisional: 07 TECHNICAL §5.12). */
export const MESH_INLINE_TRIANGLE_CAP = 100_000;

/** Triangles of the display level of detail kept in the document for an asset-backed mesh. */
export const MESH_LOD_TRIANGLES = 50_000;

/** A stored asset's reference plus the provenance its importer recorded (absent for engine results). */
export interface MeshAssetManifest extends MeshAssetRef {
  readonly source?: MeshSource;
}

export interface MeshAssetPort {
  /** Manifest of a stored mesh asset, or null when this machine does not hold it. */
  manifest(key: string): MeshAssetManifest | null;
  /** Full-resolution canonical mesh (indexed, first-use vertex order), or null when missing. */
  readMesh(key: string): MeshData | null;
  /** Store `mesh` (canonical bytes -> sha256 key); writing the same mesh twice is a no-op. */
  writeMesh(mesh: MeshData): MeshAssetRef;
  /** Raw bytes of an imported file stored by its sha256 (`import_mesh_file fileKey`), or null when missing. */
  readFile(key: string): Uint8Array | null;
}

/** `mesh` (entity-local, as stored) placed in the world by the entity's `position` and Euler `rotation` (the rule of `meshTriangles`). */
export function placeMesh(mesh: MeshData, position: Vec3, rotation: Vec3): MeshData {
  if (position.every((v) => v === 0) && isZeroRotation(rotation)) return mesh;
  const positions = new Array<number>(mesh.positions.length);
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const moved: Vec3 = [
      (mesh.positions[i] as number) + position[0],
      (mesh.positions[i + 1] as number) + position[1],
      (mesh.positions[i + 2] as number) + position[2],
    ];
    const placed = isZeroRotation(rotation) ? moved : applyEulerXYZ(moved, position, rotation);
    positions[i] = placed[0];
    positions[i + 1] = placed[1];
    positions[i + 2] = placed[2];
  }
  return { positions, indices: mesh.indices };
}
