/**
 * A stand-in for the native mesh engine that runs through the same host path (`deferredRun`, TECHNICAL_SPEC 13.8) without `llull-compute`: it answers
 * `quad_remesh` with the 6 quads of the input's bounding box after a delay, reporting progress while it waits and honouring cancellation. Tests of the
 * host (event loop, NDJSON, cancellation, idempotency, replay) use it so they run on any machine.
 */

import type { ResolveMemo } from '@core/commands/resolveMemo';
import { deferMeshOp } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshOpResult, MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { currentScope, type JobOutcome } from '../src/native/deferredRun';

export interface FakeEngine {
  readonly engine: MeshProcessingEngine;
  /** Times the engine was asked (every run of every command that reaches a quad_remesh counts). */
  readonly calls: () => number;
  /** Jobs started. */
  readonly started: () => number;
  /** The resolve memo of each resolve the engine was asked in (once per resolve, in order). */
  readonly memos: () => ResolveMemo[];
  /** Jobs that saw their signal aborted. */
  readonly killed: () => number;
  /** What the next jobs answer instead of the quads (a named failure), or null for the quads. */
  failWith(failure: MeshEngineFailure | null): void;
}

const QUADS = [
  [0, 2, 3, 1],
  [4, 5, 7, 6],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 4, 6, 2],
  [1, 3, 7, 5],
];

function boxQuads(positions: readonly number[]): MeshOpResult {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis] as number, positions[i] as number);
    max[axis] = Math.max(max[axis] as number, positions[i] as number);
  }
  const corner = (i: number): number[] => [i & 1 ? max[0]! : min[0]!, i & 2 ? max[1]! : min[1]!, i & 4 ? max[2]! : min[2]!];
  return {
    quads: { positions: Array.from({ length: 8 }, (_, i) => corner(i)).flat(), quads: QUADS.flat() },
    report: {},
    provenance: { engine: 'native', version: 'fake@0', algorithm: 'bounding box', reference: 'test', deterministic: true },
  };
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** `durationMs`: how long a job takes, in `stages` progress reports. */
export function createFakeEngine(durationMs: number, stages = 4, heartbeatMs = 5000): FakeEngine {
  let started = 0;
  let calls = 0;
  let killed = 0;
  let failure: MeshEngineFailure | null = null;
  const memos: ResolveMemo[] = [];
  const engine: MeshProcessingEngine = {
    name: 'fake-native',
    capabilities: () => new Map([['quad_remesh', Infinity]]),
    run(input, op): MeshOpResult | MeshEngineFailure {
      if (op.op !== 'quad_remesh') return { code: 'MESH_ENGINE_UNSUPPORTED', message: 'fake engine' };
      calls += 1;
      const scope = currentScope();
      if (scope === null) return { code: 'MESH_ENGINE_NEEDS_HOST', message: 'fake engine outside resolveDeferred' };
      if (!memos.includes(scope.memo)) memos.push(scope.memo);
      if (scope.deferring) return deferMeshOp('quad_remesh');
      const key = `fake:${op.targetQuads}:${input.mesh.positions.join(',')}`;
      const held = scope.lookup(key);
      if (held !== undefined) return held;
      if (scope.cancelled) return { code: 'MESH_CANCELLED', message: 'cancelled' };
      scope.request({
        key,
        op: 'quad_remesh',
        heartbeatMs,
        start: async (signal, report): Promise<JobOutcome> => {
          started += 1;
          for (let stage = 1; stage <= stages; stage++) {
            report({ stage: `stage_${stage}`, message: `stage ${stage}`, step: stage, total: stages, fraction: (stage - 1) / stages });
            await sleep(durationMs / stages, signal);
            if (signal.aborted) {
              killed += 1;
              return { code: 'MESH_CANCELLED', message: 'killed' };
            }
          }
          return failure ?? boxQuads(input.mesh.positions);
        },
      });
      return deferMeshOp('quad_remesh');
    },
  };
  return {
    engine,
    started: () => started,
    calls: () => calls,
    memos: () => memos,
    killed: () => killed,
    failWith: (next) => {
      failure = next;
    },
  };
}
