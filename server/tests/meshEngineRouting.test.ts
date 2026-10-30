/**
 * The mesh engines as the server installs them (`installGeometryKernel`: the composite of the native `llull-compute` and Manifold, wrapped by `resolveMeshEngine` with the
 * TypeScript engine in front): the preference sizes of the native engine (13.12.4) are honoured in production, not only when the native engine is installed alone, and a
 * small mesh wrapped onto a large one goes to the engine that can take the large one (13.20). Native runs need llull-compute (cargo build in solver/).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeMeshEngines, getMeshProcessingEngine, resolveMeshEngine, setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { isEngineFailure, type MeshOp, type MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { setGeometryKernel } from '@core/geometry/kernel';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { applyCommandAsync, _resetHistory } from '../src/commandBus';
import { installGeometryKernel } from '../src/geometryKernel';
import { _resetLiveDoc } from '../src/liveDocument';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createEmptyDocument } from '@core/model/types';
import { newEntity } from '@core/commands/entity/newEntity';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshEngineRouting: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

beforeAll(async () => {
  await installGeometryKernel({ env: { ...process.env, LLULL_KERNEL: 'manifold' } });
}, 120_000);

afterAll(() => {
  setMeshProcessingEngine(null);
  setGeometryKernel(null);
});

const big = icosphere(10, 6); // 81,920 triangles
const engineOf = (op: MeshOp, mesh = big): Promise<string> =>
  resolveDeferred(() => {
    _clearResultCache();
    const result = resolveMeshEngine(getMeshProcessingEngine()).run({ mesh }, op);
    return isEngineFailure(result) ? `refused ${result.code}` : result.provenance.engine;
  });

const OPS: ReadonlyArray<[string, MeshOp]> = [
  [
    'sculpt',
    {
      op: 'sculpt',
      brush: 'draw',
      stamps: [[0, 0, 10]],
      radius: 3,
      strength: 0.3,
      falloff: 'smooth',
      direction: 'area_normal',
      taubin: false,
    },
  ],
  ['repair', { op: 'repair', mode: 'clean', weldTolerance: 1e-9, maxGap: 1e-6, maxBoundaryEdges: 100 }],
  ['fill_holes', { op: 'fill_holes', select: 'all', maxBoundaryEdges: 100, fairing: 'none', refine: false }],
  ['decimate', { op: 'decimate', preserveBoundary: true, targetTriangles: 40_000 }],
  ['analyze', { op: 'analyze', weldTolerance: 0, maxListed: 5, selfIntersections: false }],
  ['shrinkwrap', { op: 'shrinkwrap', target: { mesh: icosphere(9, 4) }, mode: 'nearest', offset: 0, side: 'keep' }],
];

describe('the installed composition (native + Manifold, behind the TypeScript engine)', () => {
  native.each(OPS)('%s on 81,920 triangles is answered by the native engine', async (_name, op) => {
    expect(await engineOf(op)).toBe('native');
  });

  native('below the preference size the TypeScript engine still answers (a cold job costs more)', async () => {
    expect(await engineOf(OPS[0]?.[1] as MeshOp, icosphere(10, 3))).toBe('ts');
  });

  native('a small mesh wrapped onto a 327,680-triangle target goes native (the target is over the TypeScript cap)', async () => {
    const target = icosphere(9, 7);
    const wrap: MeshOp = { op: 'shrinkwrap', target: { mesh: target }, mode: 'nearest', offset: 0, side: 'keep' };
    expect(await engineOf(wrap, icosphere(10, 4))).toBe('native');
    const measure: MeshOp = { op: 'deviation', other: { mesh: target }, maxSamples: 500 };
    expect(await engineOf(measure, icosphere(10, 3))).toBe('native');
  });

  it('without the native engine a target over the cap is still refused by name', () => {
    const only = composeMeshEngines([tsMeshEngine]);
    const wrap: MeshOp = { op: 'shrinkwrap', target: { mesh: icosphere(9, 7) }, mode: 'nearest', offset: 0, side: 'keep' };
    expect(only.run({ mesh: icosphere(10, 3) }, wrap)).toMatchObject({ code: 'MESH_ENGINE_CAP_EXCEEDED' });
  });

  it('a composite declares the smallest preference of its members, per op', () => {
    const member = (sizes: Array<[MeshOp['op'], number]>): MeshProcessingEngine => ({
      name: 'm',
      capabilities: () => new Map(),
      preferredAbove: () => new Map(sizes),
      run: () => ({ code: 'MESH_ENGINE_UNSUPPORTED', message: 'no' }),
    });
    const merged = composeMeshEngines([
      member([['sculpt', 20_000]]),
      member([
        ['sculpt', 5_000],
        ['smooth', 9],
      ]),
      tsMeshEngine,
    ]).preferredAbove?.();
    expect(merged?.get('sculpt')).toBe(5_000);
    expect(merged?.get('smooth')).toBe(9);
  });

  native(
    'commands: sculpt_mesh and repair_mesh on an 81,920-triangle mesh of the document report the native engine',
    async () => {
      _resetHistory();
      _resetLiveDoc({
        ...createEmptyDocument(),
        units: 'mm',
        entities: { scan: newEntity('mesh', 'scan', { mesh: big }, [0, 0, 0], '#cccccc') },
        order: ['scan'],
      });
      const sculpt = await applyCommandAsync('sculpt_mesh', {
        id: 'scan',
        brush: 'inflate',
        stamps: [{ center: [0, 0, 10] }],
        radius: 3,
        strength: 0.3,
      });
      expect(sculpt.error, sculpt.summary).toBeUndefined();
      expect(sculpt.data).toMatchObject({ provenance: { engine: 'native' } });
      const repair = await applyCommandAsync('repair_mesh', { id: 'scan', mode: 'clean' });
      expect(repair.error, repair.summary).toBeUndefined();
      expect(repair.data).toMatchObject({ provenance: { engine: 'native' } });
    },
    120_000,
  );
});
