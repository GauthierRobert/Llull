/**
 * Mesh-processing port (07 MSH TR-MSH-02): commands pass triangle meshes and an operation, an installed engine answers. The default TypeScript
 * engine (`tsEngine.ts`) is always present; a host may add engines (Manifold in `packages/kernel-manifold`, native later) with
 * `setMeshProcessingEngine`. Commands read it from `ctx.meshProcessing` and resolve it with `resolveMeshEngine`. Synchronous, no native imports.
 * A slow engine (the native `llull-compute` job) answers a synchronous `run` from a result table the host fills between two runs of the same
 * command: until the result is there it calls `deferMeshOp`, the host awaits the job and runs the command again (TECHNICAL_SPEC 13.8).
 * @invariant a failure carries a stable MESH_* code; an engine never throws for bad input
 * @invariant a deferred answer (code MESH_ENGINE_PENDING) is a refusal the host discards: it re-runs the command once the result exists; replay never memoizes a step that deferred
 * @invariant the composite asks engines in order and falls through only on MESH_ENGINE_UNSUPPORTED / over-cap
 */

import type { MeshEngineFailure, MeshOpName, MeshProcessingEngine } from './engineTypes';
import { isEngineFailure } from './engineTypes';
import { tsMeshEngine } from './tsEngine';

/** Code of the refusal of an engine that only answers through the host's resolving path (the native one, outside `resolveDeferred`): the next engine may answer. */
export const MESH_ENGINE_NEEDS_HOST = 'MESH_ENGINE_NEEDS_HOST';

/**
 * Engines asked in order; the first that lists the op (under its cap) answers, an UNSUPPORTED / NEEDS_HOST failure moves on. An engine that declares
 * `preferredAbove` for the op goes first for inputs above that many triangles (the results are identical by the parity rule: only the speed changes).
 * The refusal reported when nobody answers is the one of the last engine, in the listed order, that refused.
 */
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
      const preferred = (engine: MeshProcessingEngine): boolean => (engine.preferredAbove?.().get(op.op) ?? Infinity) < triangles;
      const order = [...engines.filter(preferred), ...engines.filter((engine) => !preferred(engine))];
      const refusals = new Map<number, MeshEngineFailure>();
      for (const engine of order) {
        const cap = engine.capabilities().get(op.op);
        if (cap === undefined) continue;
        const position = engines.indexOf(engine);
        if (triangles > cap) {
          refusals.set(position, {
            code: 'MESH_ENGINE_CAP_EXCEEDED',
            message: `"${op.op}" on ${triangles} triangles exceeds the ${engine.name} engine cap of ${cap}`,
          });
          continue;
        }
        const result = engine.run(input, op);
        if (!isEngineFailure(result) || (result.code !== 'MESH_ENGINE_UNSUPPORTED' && result.code !== MESH_ENGINE_NEEDS_HOST))
          return result;
        refusals.set(position, result);
      }
      const last = Math.max(-1, ...refusals.keys());
      return refusals.get(last) ?? { code: 'MESH_ENGINE_UNSUPPORTED', message: `no installed mesh engine answers "${op.op}"` };
    },
  };
}

let deferrals = 0;

/** Code of the refusal an engine answers while the result it was asked for is still being computed. */
export const MESH_ENGINE_PENDING = 'MESH_ENGINE_PENDING';

/** The answer of an engine whose result is not there yet (the host awaits it and runs the command again); counted by `deferralCount`. */
export function deferMeshOp(op: MeshOpName): MeshEngineFailure {
  deferrals += 1;
  return { code: MESH_ENGINE_PENDING, message: `the '${op}' result is still being computed` };
}

/** How many answers were deferred so far: a caller that sees it change across a run knows that run saw a refusal it must not keep or memoize. */
export function deferralCount(): number {
  return deferrals;
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
