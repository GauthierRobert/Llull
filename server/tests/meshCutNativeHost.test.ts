/**
 * `cut_mesh` on a stored 327,680-triangle mesh through the real host (DES-7c step 7, slice 4, TECHNICAL_SPEC 13.15.1): the TypeScript engine answers above its old
 * 200,000 cap (the cap of `cut` is 4,000,000), the input is read at full resolution through the asset store and the result goes back through it. The native engine
 * is installed when built, to show that it does not take the op away.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { type CadDocument, createEmptyDocument, type MeshData, type MeshSolidEntity } from '@core/model/types';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { _clearResultCache } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-mesh-cut-')), 'cache');

const BINARY = nativeBinaryPath('llull-compute');

let scanMesh: MeshData;
let sourceKey = '';

beforeAll(() => {
  scanMesh = icosphere(10, 7);
  sourceKey = defaultMeshAssetStore().writeMesh(scanMesh).key;
}, 120_000);

/** A document holding the stored mesh as `scan`, with a tiny display mesh standing for it. */
function scanDocument(): CadDocument {
  const reference = defaultMeshAssetStore().writeMesh(scanMesh);
  const entity = newEntity('mesh', 'scan', { mesh: icosphere(10, 1), asset: reference }, [0, 0, 0], '#cccccc');
  return { ...createEmptyDocument(), units: 'mm', entities: { scan: entity }, order: ['scan'] };
}

beforeEach(() => {
  _clearResultCache();
  _resetLiveDoc(scanDocument());
  _resetHistory();
});

afterEach(() => {
  setMeshProcessingEngine(null);
});

const scan = (): MeshSolidEntity => getLiveDoc().entities['scan'] as MeshSolidEntity;

describe.each([
  ['the TypeScript engine alone', null],
  ['with the native engine installed', BINARY],
] as const)('cut_mesh of a 327,680-triangle stored mesh, %s', (_label, binary) => {
  const install = (): void => setMeshProcessingEngine(binary === null ? null : createNativeMeshEngine({ binary }));

  it('reads the full-resolution input, cuts and caps it in process and stores the result', async () => {
    install();
    const result = await applyCommandAsync('cut_mesh', { id: 'scan', plane: { origin: [0, 0, 1], normal: [0, 0, 1] }, keep: 'both' });
    expect(result.error, result.summary).toBeUndefined();
    const data = result.data as {
      provenance: { engine: string };
      uncapped: number;
      volumes: { positive: number; negative: number };
      ids: string[];
    };
    expect(data.provenance.engine).toBe('ts');
    expect(data.uncapped).toBe(0);
    // the two halves of a 4/3 pi r^3 sphere (an icosphere is a little smaller), cut at z = 1
    expect(data.volumes.positive + data.volumes.negative).toBeGreaterThan(4000);
    expect(data.volumes.negative).toBeGreaterThan(data.volumes.positive);
    expect(scan().asset?.key).not.toBe(sourceKey);
    expect(scan().asset?.triangles).toBeGreaterThan(100_000);
    expect(data.ids).toHaveLength(2);
  }, 120_000);

  it('a plane that misses the stored mesh is still refused by name, leaving the document', async () => {
    install();
    const before = getLiveDoc();
    const result = await applyCommandAsync('cut_mesh', { id: 'scan', plane: { origin: [0, 0, 50], normal: [0, 0, 1] } });
    expect(result.error?.code).toBe('MESH_CUT_MISSES');
    expect(getLiveDoc()).toBe(before);
  }, 120_000);
});
