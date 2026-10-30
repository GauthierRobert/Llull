/**
 * quad_remesh of open and symmetric inputs with the boundary-aligned row (TECHNICAL_SPEC 13.28) on the real QuadriFlow job: the two inputs that were refused before (a hemisphere of
 * level 5 at 1000 quads, a closed sphere of level 6 at 4000 with symmetry yz) now work, the row is on the rim, and a closed result without symmetry is unchanged. Native runs need
 * llull-compute (cargo build in solver/) and are skipped otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { type MeshData, createEmptyDocument } from '@core/model/types';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { _resetLiveDoc } from '../src/liveDocument';
import { _clearResultCache } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('quadRowNative: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

function hemisphere(level: number): MeshData {
  const sphere = icosphere(10, level);
  const indices: number[] = [];
  for (let t = 0; t < sphere.indices.length; t += 3) {
    const c = [0, 1, 2].map((k) => sphere.indices[t + k] as number);
    if (c.every((v) => (sphere.positions[3 * v + 2] as number) > -1e-9)) indices.push(...c);
  }
  return { positions: sphere.positions, indices };
}

function load(mesh: MeshData): void {
  _clearResultCache();
  _resetHistory();
  const body = newEntity('mesh', 'm', { mesh }, [0, 0, 0], '#cccccc');
  _resetLiveDoc({ ...createEmptyDocument(), units: 'mm', entities: { m: body }, order: ['m'] });
}

beforeEach(() => setMeshProcessingEngine(BINARY === null ? null : createNativeMeshEngine({ binary: BINARY })));
afterEach(() => setMeshProcessingEngine(null));

describe('quad_remesh boundary row on the real engine (13.28)', () => {
  native(
    'a hemisphere of level 5 at 1000 quads is realigned (it was SNAP_FAILED): the row is on the rim, a count within 25 % of the target',
    async () => {
      load(hemisphere(5));
      const result = await applyCommandAsync('quad_remesh', { id: 'm', targetQuadCount: 1000, output: 'mesh' });
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as Record<string, unknown>;
      expect(data).toMatchObject({ open: true, boundaryRow: 'realigned', boundaryLoops: 1 });
      expect(data['boundaryRowQuads'] as number).toBeGreaterThan(40);
      expect(Math.abs((data['targetRatio'] as number) - 1)).toBeLessThan(0.25);
    },
    240_000,
  );

  native(
    'a closed sphere of level 6 at 4000 quads with symmetry yz is realigned too (it was SNAP_FAILED)',
    async () => {
      load(icosphere(10, 6));
      const result = await applyCommandAsync('quad_remesh', { id: 'm', targetQuadCount: 4000, output: 'mesh', symmetry: { plane: 'yz' } });
      expect(result.error, result.summary).toBeUndefined();
      expect(result.data).toMatchObject({ symmetry: { plane: 'yz' }, boundaryRow: 'realigned' });
    },
    240_000,
  );

  native(
    'a closed result without symmetry does not go through the row at all and keeps its count',
    async () => {
      load(icosphere(10, 4));
      const result = await applyCommandAsync('quad_remesh', { id: 'm', targetQuadCount: 600, output: 'mesh' });
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as Record<string, unknown>;
      expect(data['quads']).toBe(614);
      expect(data).not.toHaveProperty('boundaryRow');
    },
    240_000,
  );
});
