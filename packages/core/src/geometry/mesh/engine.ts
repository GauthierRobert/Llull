/**
 * Mesh-processing port (07 MSH TR-MSH-02): commands pass triangle meshes and an operation, an installed engine answers. The default TypeScript
 * engine (`tsEngine.ts`) is always present; a host may add engines (Manifold in `packages/kernel-manifold`, native later) with
 * `setMeshProcessingEngine`. Commands read it from `ctx.meshProcessing` and resolve it with `resolveMeshEngine`. Synchronous, no native imports.
 * @invariant a failure carries a stable MESH_* code; an engine never throws for bad input
 * @invariant the composite asks engines in order and falls through only on MESH_ENGINE_UNSUPPORTED / over-cap
 */

import type { MeshEngineFailure, MeshOpName, MeshProcessingEngine } from './engineTypes';
import { isEngineFailure } from './engineTypes';
import { tsMeshEngine } from './tsEngine';

/** Engines asked in order; the first that lists the op (under its cap) answers, an UNSUPPORTED failure moves on. */
export function composeMeshEngines(engines: ReadonlyArray<MeshProcessingEngine>): MeshProcessingEngine {
  return {
    name: engines.map((engine) => engine.name).join('+'),
    capabilities() {
      const merged = new Map<MeshOpName, number>();
      for (const engine of engines) for (const [op, cap] of engine.capabilities()) merged.set(op, Math.max(merged.get(op) ?? 0, cap));
      return merged;
    },
    run(input, op) {
      const triangles = op.op === 'hull' ? Math.floor(op.points.length / 3) : Math.floor(input.mesh.indices.length / 3);
      let refusal: MeshEngineFailure = { code: 'MESH_ENGINE_UNSUPPORTED', message: `no installed mesh engine answers "${op.op}"` };
      for (const engine of engines) {
        const cap = engine.capabilities().get(op.op);
        if (cap === undefined) continue;
        if (triangles > cap) {
          refusal = {
            code: 'MESH_ENGINE_CAP_EXCEEDED',
            message: `"${op.op}" on ${triangles} triangles exceeds the ${engine.name} engine cap of ${cap}`,
          };
          continue;
        }
        const result = engine.run(input, op);
        if (!isEngineFailure(result) || result.code !== 'MESH_ENGINE_UNSUPPORTED') return result;
        refusal = result;
      }
      return refusal;
    },
  };
}

let installed: MeshProcessingEngine | null = null;

/** Install (or clear with null) the host's extra engine (Manifold / native); the TypeScript engine always stays first. */
export function setMeshProcessingEngine(engine: MeshProcessingEngine | null): void {
  installed = engine;
}

export function getMeshProcessingEngine(): MeshProcessingEngine | null {
  return installed;
}

/** The engine a command uses: the TypeScript engine, then `engine` when given. */
export function resolveMeshEngine(engine: MeshProcessingEngine | null | undefined): MeshProcessingEngine {
  return engine === null || engine === undefined ? tsMeshEngine : composeMeshEngines([tsMeshEngine, engine]);
}
