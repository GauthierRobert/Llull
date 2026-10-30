/**
 * `sculpt_mesh` `along` on the native engine (DES-7c leftovers, TECHNICAL_SPEC 13.19): the stamps of a path are computed by the command, so the native twin of slice 3 gets
 * explicit stamps and gives the bytes of the TypeScript engine, for polylines, with symmetry and refinement (the curve path is covered by tests/unit/mesh/sculptAlong.test.ts: it reaches the engine as the same explicit stamps). Native runs need llull-compute (cargo build in solver/).
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { MeshSolidEntity } from '@core/model/types';
import { docWithMeshes, icosphere } from '../../tests/helpers/meshFixtures';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('sculptAlongNative: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });
const nativeContext = (): ExecutionContext => ({ ...defaultContext(), meshProcessing: engine });

const { doc, ids } = docWithMeshes(icosphere(10, 6));
const id = ids[0] as string;
const positionsOf = (result: CommandResult): number[] => [
  ...(result.document.entities[result.affected[0] as string] as MeshSolidEntity).mesh.positions,
];

describe('sculpt_mesh along on the native engine', () => {
  const arc: Array<[number, number, number]> = Array.from({ length: 30 }, (_, k) => [Math.sin(k / 6) * 6, Math.cos(k / 6) * 2, 9.6]);
  const runs = [
    ['a polyline', { along: { points: arc, spacing: 0.7 } }],
    ['a polyline mirrored and refined', { along: { points: arc, spacing: 1.1 }, symmetry: { plane: 'yz' }, refineEdge: 0.5 }],
  ] as const;

  native.each(runs)(
    '%s: the native job returns the bytes of the TypeScript engine, and the native engine was the one asked',
    async (_name, extra) => {
      const params = { id, brush: 'draw', radius: 2, strength: 0.3, ...extra };
      const ts = execute(doc, 'sculpt_mesh', params);
      expect(ts.error, ts.summary).toBeUndefined();
      _clearResultCache();
      const nat = await resolveDeferred(() => execute(doc, 'sculpt_mesh', params, nativeContext()));
      expect(nat.error, nat.summary).toBeUndefined();
      expect((nat.data as { provenance: { engine: string } }).provenance.engine).toBe('native');
      expect((ts.data as { provenance: { engine: string } }).provenance.engine).toBe('ts');
      expect(positionsOf(nat)).toEqual(positionsOf(ts));
      expect((nat.data as { stamps: number }).stamps).toBeGreaterThan(5);
      expect({ ...(nat.data as object), provenance: null, deviation: null }).toMatchObject({
        movedVertices: (ts.data as { movedVertices: number }).movedVertices,
      });
    },
    120_000,
  );
});
