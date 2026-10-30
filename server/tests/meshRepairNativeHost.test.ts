/**
 * `repair_mesh`, `fill_mesh_holes` and `check_mesh` on stored meshes through the real host (DES-7c step 7, slice 2, TECHNICAL_SPEC 13.13): the native engine answers
 * above the TypeScript cap and, between its preference sizes and that cap, instead of the TypeScript engine; the input is read at full resolution through the asset
 * store; results above the inline cap go back through the store and a result that fits inline drops the asset reference; the job reports its stages and honours
 * cancellation and the timeout (13.8). The real binary and the real content-addressed store.
 * Native runs need llull-compute (cargo build --release in solver/) and are skipped with a logged reason otherwise.
 */

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { MESH_INLINE_TRIANGLE_CAP } from '@core/geometry/mesh/assets';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { type CadDocument, createEmptyDocument, type MeshData, type MeshSolidEntity } from '@core/model/types';
import { gridMesh, icosphere } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { liveChildCount } from '../src/childProcesses';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { withHoles } from './meshopsNativeSupport';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-mesh-repair-')), 'cache');

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshRepairNativeHost: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const NDJSON = 'application/x-ndjson';
const HOLES = 20;
/** Icosphere level 7 (327,680 triangles) minus 20 fans of 6: above the 200,000 of the TypeScript engine and the 100,000 kept inline. */
const SOURCE_TRIANGLES = 327_680 - 6 * HOLES;

let server: Server;
let base = '';
let holey: MeshData;
let sourceKey = '';

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  holey = withHoles(icosphere(10, 7), HOLES);
  sourceKey = defaultMeshAssetStore().writeMesh(holey).key;
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A document holding the stored mesh as `scan`, with a tiny display mesh standing for it (the document never holds the 327,680 triangles). */
function scanDocument(): CadDocument {
  const reference = defaultMeshAssetStore().writeMesh(holey);
  const entity = newEntity('mesh', 'scan', { mesh: icosphere(10, 1), asset: reference }, [0, 0, 0], '#cccccc');
  return { ...createEmptyDocument(), units: 'mm', entities: { scan: entity }, order: ['scan'] };
}

beforeEach(() => {
  _clearResultCache();
  _resetLiveDoc(scanDocument());
  _resetHistory();
  setMeshProcessingEngine(createNativeMeshEngine({ binary: BINARY as string }));
});

afterEach(() => {
  setMeshProcessingEngine(null);
});

const scan = (): MeshSolidEntity => getLiveDoc().entities['scan'] as MeshSolidEntity;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const post = (name: string, params: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ name, params }),
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as object) },
  });

/** Wait until llull-compute runs (the job of the command in flight), at most `limitMs`. */
async function waitForChild(limitMs: number): Promise<void> {
  for (let waited = 0; waited < limitMs && liveChildCount() === 0; waited += 10) await sleep(10);
}

describe('fill_mesh_holes of a 327,680-triangle stored mesh', () => {
  native('reads the full-resolution input, closes every hole, measures the deviation in the same job and stores the result', async () => {
    const result = await applyCommandAsync('fill_mesh_holes', { id: 'scan' });
    expect(result.error, result.summary).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data['provenance']).toMatchObject({ engine: 'native', deterministic: true });
    expect(data['totalLoops']).toBe(HOLES);
    expect((data['filled'] as unknown[]).length).toBe(HOLES);
    expect(data['closedBefore']).toBe(false);
    expect(data['closed']).toBe(true);
    // the input was the stored mesh, not its 80-triangle display level of detail
    const patch = (data['filled'] as Array<{ triangles: number }>).reduce((sum, hole) => sum + hole.triangles, 0);
    expect(data['faces']).toBe(SOURCE_TRIANGLES + patch);
    expect(data['deviation']).toMatchObject({ unit: 'mm' });
    expect(data['deviationSkipped']).toBeUndefined();
    const entity = scan();
    expect(entity.asset?.key).not.toBe(sourceKey);
    expect(entity.asset?.triangles).toBe(data['faces']);
    expect(defaultMeshAssetStore().readMesh(entity.asset?.key as string)?.indices.length).toBe((data['faces'] as number) * 3);
  });

  native('chosen loops, a point and a number that names no loop are answered like the TypeScript engine words them', async () => {
    const one = await applyCommandAsync('fill_mesh_holes', { id: 'scan', holes: [3], fairing: 'none' });
    expect(one.error, one.summary).toBeUndefined();
    expect((one.data as { filled: unknown[] }).filled).toHaveLength(1);
    expect((one.data as { closed: boolean }).closed).toBe(false);
    _resetLiveDoc(scanDocument());
    const refused = await applyCommandAsync('fill_mesh_holes', { id: 'scan', holes: [HOLES + 5] });
    expect(refused.error?.code).toBe('MESH_HOLE_NOT_FOUND');
    expect(refused.summary).toContain(`boundary loop ${HOLES + 5} does not exist (the mesh has ${HOLES})`);
    const tooLarge = await applyCommandAsync('fill_mesh_holes', { id: 'scan', holes: [0], maxBoundaryEdges: 3 });
    expect(tooLarge.error?.code).toBe('MESH_HOLE_TOO_LARGE');
    expect(scan().asset?.key).toBe(sourceKey);
  });

  native('streams the stages in order with rising fractions and ends in the result', async () => {
    const response = await post('fill_mesh_holes', { id: 'scan' }, { headers: { Accept: NDJSON } });
    const lines = (await response.text())
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)?.['type']).toBe('result');
    const progress = lines.filter((line) => line['type'] === 'progress' && line['heartbeat'] !== true);
    const stages = progress.map((line) => line['stage'] as string).filter((stage, i, all) => stage !== all[i - 1]);
    expect(stages.slice(-4)).toEqual(['read', 'fill_holes', 'deviation', 'write']);
    const fractions = progress.map((line) => line['fraction'] as number);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(_runningJobCount()).toBe(0);
    expect(liveChildCount()).toBe(0);
  });
});

describe('repair_mesh of a 327,680-triangle stored mesh', () => {
  native('every mode answers natively at full resolution and close_holes leaves a closed mesh', async () => {
    for (const mode of ['weld', 'clean', 'orient', 'stitch'] as const) {
      _resetLiveDoc(scanDocument());
      const result = await applyCommandAsync('repair_mesh', { id: 'scan', mode });
      expect(result.error, `${mode}: ${result.summary}`).toBeUndefined();
      const data = result.data as Record<string, unknown>;
      expect(data['facesBefore'], mode).toBe(SOURCE_TRIANGLES);
      expect(data['provenance'], mode).toMatchObject({ engine: 'native' });
      expect(data['closed'], mode).toBe(false);
    }
    _resetLiveDoc(scanDocument());
    const closed = await applyCommandAsync('repair_mesh', { id: 'scan', mode: 'close_holes' });
    expect(closed.error, closed.summary).toBeUndefined();
    const data = closed.data as { closed: boolean; changes: { holesFilled: number }; faces: number; deviation: unknown };
    expect(data.closed).toBe(true);
    expect(data.changes.holesFilled).toBe(HOLES);
    expect(data.faces).toBeGreaterThan(SOURCE_TRIANGLES);
    expect(data.deviation).toMatchObject({ unit: 'mm' });
    expect(scan().asset?.triangles).toBe(data.faces);
  });

  native('LLULL_MESH_OP_TIMEOUT_S ends the job with MESH_TIMEOUT, kills the process and leaves the document', async () => {
    setMeshProcessingEngine(createNativeMeshEngine({ binary: BINARY as string, env: { ...process.env, LLULL_MESH_OP_TIMEOUT_S: '0.1' } }));
    const before = getLiveDoc();
    const body = (await (await post('repair_mesh', { id: 'scan', mode: 'close_holes' })).json()) as { error?: { code: string } };
    expect(body.error?.code).toBe('MESH_TIMEOUT');
    expect(getLiveDoc()).toBe(before);
    expect(liveChildCount()).toBe(0);
  });

  native('closing the connection kills llull-compute and applies nothing', async () => {
    const before = getLiveDoc();
    const controller = new AbortController();
    const pending = post('repair_mesh', { id: 'scan', mode: 'close_holes' }, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await waitForChild(15_000);
    expect(liveChildCount()).toBe(1);
    controller.abort();
    await pending;
    // the process tree dies asynchronously (slower under load): wait on the observable, bounded
    for (let waited = 0; waited < 10_000 && liveChildCount() > 0; waited += 50) await sleep(50);
    expect(liveChildCount()).toBe(0);
    expect(_runningJobCount()).toBe(0);
    expect(getLiveDoc()).toBe(before);
  });
});

describe('between the native preference sizes and the TypeScript cap', () => {
  /** A sphere of 81,920 triangles with holes (above the 50,000 and 30,000 preferences) and a shell of 29,768 faces far away: 111,688 stored triangles. */
  const withShell = (): MeshData => {
    const sphere = withHoles(icosphere(10, 6), 10);
    const shell = gridMesh(10, 122);
    const offset = sphere.positions.length / 3;
    return {
      positions: [...sphere.positions, ...shell.positions.map((v, i) => (i % 3 === 0 ? v + 100 : v))],
      indices: [...sphere.indices, ...shell.indices.map((v) => v + offset)],
    };
  };

  native(
    'repair_mesh goes native, a result that fits inline drops the asset reference, and check_mesh follows',
    async () => {
      const mesh = withShell();
      const reference = defaultMeshAssetStore().writeMesh(mesh);
      expect(mesh.indices.length / 3).toBeGreaterThan(MESH_INLINE_TRIANGLE_CAP);
      const entity = newEntity('mesh', 'scan', { mesh: icosphere(10, 1), asset: reference }, [0, 0, 0], '#cccccc');
      _resetLiveDoc({ ...createEmptyDocument(), units: 'mm', entities: { scan: entity }, order: ['scan'] });
      const result = await applyCommandAsync('repair_mesh', {
        id: 'scan',
        mode: 'close_holes',
        removeSmallComponents: { maxFaces: 40_000 },
      });
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as { provenance: { engine: string }; changes: Record<string, number>; faces: number; closed: boolean };
      expect(data.provenance.engine).toBe('native');
      expect(data.changes).toMatchObject({ holesFilled: 10, componentsRemoved: 1, facesRemovedWithComponents: 29_768 });
      expect(data.closed).toBe(true);
      expect(data.faces).toBeLessThanOrEqual(MESH_INLINE_TRIANGLE_CAP);
      expect(scan().asset).toBeUndefined();
      expect(scan().mesh.indices.length / 3).toBe(data.faces);
      const checked = await applyCommandAsync('check_mesh', { ids: ['scan'], purpose: 'print' });
      expect(checked.error, checked.summary).toBeUndefined();
      expect((checked.data as { meshes: Array<{ triangles: number }> }).meshes[0]?.triangles).toBe(data.faces);
    },
    120_000,
  );

  native(
    'fill_mesh_holes on a mesh the document holds inline: the native engine is asked, below 30,000 the TypeScript one',
    async () => {
      const doc = (mesh: MeshData): CadDocument => ({
        ...createEmptyDocument(),
        units: 'mm',
        entities: { scan: newEntity('mesh', 'scan', { mesh }, [0, 0, 0], '#cccccc') },
        order: ['scan'],
      });
      _resetLiveDoc(doc(withHoles(icosphere(10, 6), 10)));
      const large = await applyCommandAsync('fill_mesh_holes', { id: 'scan' });
      expect(large.error, large.summary).toBeUndefined();
      expect(large.data).toMatchObject({ provenance: { engine: 'native' }, closed: true });
      _resetLiveDoc(doc(withHoles(icosphere(10, 5), 10)));
      const small = await applyCommandAsync('fill_mesh_holes', { id: 'scan' });
      expect(small.error, small.summary).toBeUndefined();
      expect(small.data).toMatchObject({ provenance: { engine: 'ts' }, closed: true });
    },
    120_000,
  );
});
