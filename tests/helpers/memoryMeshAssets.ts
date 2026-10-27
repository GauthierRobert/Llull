/** In-memory twin of the host mesh asset store: keys are the sha256 of a canonical JSON of the mesh. USE IN TESTS ONLY. */

import { createHash } from 'node:crypto';
import type { MeshAssetManifest, MeshAssetPort } from '@core/geometry/mesh/assets';
import type { MeshData } from '@core/model/types';

export interface MemoryMeshAssets extends MeshAssetPort {
  readonly meshes: Map<string, MeshData>;
  readonly files: Map<string, Uint8Array>;
  putFile(bytes: Uint8Array): string;
}

export function memoryMeshAssets(): MemoryMeshAssets {
  const meshes = new Map<string, MeshData>();
  const files = new Map<string, Uint8Array>();
  const manifests = new Map<string, MeshAssetManifest>();
  const key = (mesh: MeshData): string =>
    createHash('sha256')
      .update(JSON.stringify([mesh.positions, mesh.indices]))
      .digest('hex');
  return {
    meshes,
    files,
    manifest: (k) => manifests.get(k) ?? null,
    readMesh: (k) => meshes.get(k) ?? null,
    writeMesh(mesh) {
      const k = key(mesh);
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i++) {
        const axis = i % 3;
        min[axis] = Math.min(min[axis] as number, mesh.positions[i] as number);
        max[axis] = Math.max(max[axis] as number, mesh.positions[i] as number);
      }
      const bounds = { min, max };
      const ref = { key: k, triangles: mesh.indices.length / 3, vertices: mesh.positions.length / 3, bounds };
      meshes.set(k, mesh);
      manifests.set(k, ref);
      return ref;
    },
    readFile: (k) => files.get(k) ?? null,
    putFile(bytes) {
      const k = createHash('sha256').update(bytes).digest('hex');
      files.set(k, bytes);
      return k;
    },
  };
}
