/** The harmonic map of a region of a mesh through the installed mesh engines (13.26): the region is cut out as a mesh of its own, the engine maps it (TypeScript up to its cap, native above), the vertex numbers are mapped back. */

import type { MeshEngineFailure, MeshProcessingEngine } from '../../geometry/mesh/engineTypes';
import type { HarmonicMap, HarmonicRefusal } from '../../geometry/mesh/harmonicMap';
import type { MeshData } from '../../model/types';

/** The region's triangles as a mesh of its own: the vertices it uses, ascending (so every vertex-order rule of the map is the same as on the whole mesh), renumbered. */
function regionMesh(mesh: MeshData, faces: ReadonlyArray<number>): { sub: MeshData; used: number[] } {
  const used = [...new Set(faces.flatMap((f) => [0, 1, 2].map((k) => mesh.indices[3 * f + k] as number)))].sort((a, b) => a - b);
  const local = new Map(used.map((v, i) => [v, i]));
  return {
    sub: {
      positions: used.flatMap((v) => [
        mesh.positions[3 * v] as number,
        mesh.positions[3 * v + 1] as number,
        mesh.positions[3 * v + 2] as number,
      ]),
      indices: faces.flatMap((f) => [0, 1, 2].map((k) => local.get(mesh.indices[3 * f + k] as number) as number)),
    },
    used,
  };
}

/**
 * Harmonic map of the region `faces` of `mesh` by `engine`: the map, the refusal of the region (`MESH_FIT_NOT_DISK`, `MESH_FIT_PARAM_FOLDED`), or the failure of the engine
 * (a deferred native job `MESH_ENGINE_PENDING`, over its cap, cancelled, ...), which the command reports as it is.
 */
export function regionHarmonic(
  engine: MeshProcessingEngine,
  mesh: MeshData,
  faces: ReadonlyArray<number>,
): HarmonicMap | HarmonicRefusal | MeshEngineFailure {
  const { sub, used } = regionMesh(mesh, faces);
  const answer = engine.run({ mesh: sub }, { op: 'harmonic_map' });
  if ('code' in answer) return answer;
  const mapped = answer.harmonic;
  if (mapped === undefined) return { code: 'MESH_ENGINE_UNSUPPORTED', message: 'the engine returned no harmonic map' };
  const uv = new Map<number, [number, number]>();
  mapped.vertices.forEach((v, i) => uv.set(used[v] as number, [mapped.uv[2 * i] as number, mapped.uv[2 * i + 1] as number]));
  return {
    uv,
    weights: mapped.weights,
    flippedFirst: mapped.flippedFirst,
    collapsedInParameters: mapped.collapsedInParameters,
    interiorVertices: mapped.interiorVertices,
    boundaryVertices: mapped.boundaryVertices,
    cgIterations: mapped.cgIterations,
    cgResidual: mapped.cgResidual,
    corners: mapped.corners.map((c) => used[c] as number) as unknown as HarmonicMap['corners'],
  };
}

/** True for the refusals of the region itself (the other failures are the engine's). */
export const isRegionRefusal = (value: HarmonicMap | HarmonicRefusal | MeshEngineFailure): value is HarmonicRefusal =>
  'code' in value && value.code.startsWith('MESH_FIT_');
