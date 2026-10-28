/**
 * `remesh_mesh`, `analyze_mesh` and `check_mesh` on a stored mesh through the real host (DES-7c step 7, TECHNICAL_SPEC 13.12): the native engine answers above the
 * TypeScript cap, the input is read at full resolution through the asset store, results above the inline cap go back through the store with no stale asset
 * reference, the job reports its stages and honours cancellation and the timeout (13.8). The real binary and the real content-addressed store.
 * Native runs need llull-compute (cargo build --release in solver/) and are skipped with a logged reason otherwise.
 */

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { MESH_INLINE_TRIANGLE_CAP, MESH_LOD_TRIANGLES } from '@core/geometry/mesh/assets';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { type CadDocument, createEmptyDocument, type MeshSolidEntity } from '@core/model/types';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { liveChildCount } from '../src/childProcesses';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-mesh-edit-')), 'cache');

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshEditNativeHost: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const NDJSON = 'application/x-ndjson';
/** Icosphere level 7: 327 680 triangles, above the 200 000 of the TypeScript engine and the 100 000 kept inline. */
const SOURCE_TRIANGLES = 327_680;

let server: Server;
let base = '';
let sourceKey = '';

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reference = defaultMeshAssetStore().writeMesh(icosphere(10, 7));
  sourceKey = reference.key;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A document holding the stored sphere as `scan`, with a tiny display mesh standing for it (the document never holds the 327 680 triangles). */
function scanDocument(): CadDocument {
  const reference = defaultMeshAssetStore().writeMesh(icosphere(10, 7));
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

describe('remesh_mesh of a 327 680-triangle stored mesh', () => {
  native(
    'reads the full-resolution input, measures the deviation in the same job and stores the result without a stale asset reference',
    async () => {
      const result = await applyCommandAsync('remesh_mesh', { id: 'scan', targetEdgeLength: 0.13, iterations: 2 });
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as Record<string, unknown>;
      // the input was the stored mesh, not its 80-triangle display level of detail
      expect(data['trianglesBefore']).toBe(SOURCE_TRIANGLES);
      expect(data['provenance']).toMatchObject({ engine: 'native', deterministic: true });
      expect(data['deviation']).toMatchObject({ unit: 'mm' });
      expect(data['deviationSkipped']).toBeUndefined();
      const entity = scan();
      expect(entity.asset).toBeDefined();
      expect(entity.asset?.key).not.toBe(sourceKey);
      expect(entity.asset?.triangles).toBe(data['faces']);
      // the document keeps a display level of detail of about MESH_LOD_TRIANGLES, not the stored mesh
      expect(entity.mesh.indices.length / 3).toBeLessThan(2 * MESH_LOD_TRIANGLES);
      expect(entity.mesh.indices.length / 3).toBeLessThan(entity.asset?.triangles as number);
      const stored = defaultMeshAssetStore().readMesh(entity.asset?.key as string);
      expect(stored?.indices.length).toBe((data['faces'] as number) * 3);
      expect(data['faces'] as number).toBeGreaterThan(MESH_INLINE_TRIANGLE_CAP);
    },
  );

  native('a result that fits inline drops the asset reference of the source', async () => {
    const result = await applyCommandAsync('remesh_mesh', { id: 'scan', targetEdgeLength: 0.5, iterations: 2 });
    expect(result.error, result.summary).toBeUndefined();
    const faces = (result.data as { faces: number }).faces;
    expect(faces).toBeLessThanOrEqual(MESH_INLINE_TRIANGLE_CAP);
    expect(scan().asset).toBeUndefined();
    expect(scan().mesh.indices.length / 3).toBe(faces);
  });

  native('an edge above a quarter of the bounding-box diagonal is refused by name before any job', async () => {
    const refused = await applyCommandAsync('remesh_mesh', { id: 'scan', targetEdgeLength: 9 });
    expect(refused.error?.code).toBe('MESH_REMESH_EDGE_TOO_LARGE');
    expect(_runningJobCount()).toBe(0);
  });

  native('streams the stages in order with rising fractions and ends in the result', async () => {
    const response = await post('remesh_mesh', { id: 'scan', targetEdgeLength: 0.13, iterations: 2 }, { headers: { Accept: NDJSON } });
    const lines = (await response.text())
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)?.['type']).toBe('result');
    const progress = lines.filter((line) => line['type'] === 'progress' && line['heartbeat'] !== true);
    const stages = progress.map((line) => line['stage'] as string).filter((stage, i, all) => stage !== all[i - 1]);
    expect(stages.slice(-4)).toEqual(['read', 'remesh', 'deviation', 'write']);
    expect(progress.filter((line) => line['stage'] === 'remesh').length).toBeGreaterThan(1);
    const fractions = progress.map((line) => line['fraction'] as number);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(_runningJobCount()).toBe(0);
    expect(liveChildCount()).toBe(0);
  });

  native('LLULL_MESH_OP_TIMEOUT_S ends the job with MESH_TIMEOUT, kills the process and leaves the document', async () => {
    setMeshProcessingEngine(createNativeMeshEngine({ binary: BINARY as string, env: { ...process.env, LLULL_MESH_OP_TIMEOUT_S: '0.3' } }));
    const before = getLiveDoc();
    const body = (await (await post('remesh_mesh', { id: 'scan', targetEdgeLength: 0.13, iterations: 2 })).json()) as {
      isError: boolean;
      error?: { code: string };
    };
    expect(body.error?.code).toBe('MESH_TIMEOUT');
    expect(getLiveDoc()).toBe(before);
    expect(liveChildCount()).toBe(0);
  });

  native('closing the connection kills llull-compute and applies nothing', async () => {
    const before = getLiveDoc();
    const controller = new AbortController();
    const pending = post('remesh_mesh', { id: 'scan', targetEdgeLength: 0.13, iterations: 12 }, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await sleep(1500);
    expect(liveChildCount()).toBe(1);
    controller.abort();
    await pending;
    await sleep(500);
    expect(liveChildCount()).toBe(0);
    expect(_runningJobCount()).toBe(0);
    expect(getLiveDoc()).toBe(before);
  });
});

describe('analyze_mesh and check_mesh above the TypeScript cap', () => {
  native('analyze_mesh answers for 327 680 triangles with the sums of a closed sphere', async () => {
    const result = await applyCommandAsync('analyze_mesh', { id: 'scan' });
    expect(result.error, result.summary).toBeUndefined();
    const data = result.data as Record<string, number | boolean | null>;
    expect(data).toMatchObject({
      faces: SOURCE_TRIANGLES,
      closed: true,
      manifold: true,
      orientationConsistent: true,
      shellCount: 1,
      genus: 0,
    });
    expect(data['selfIntersectionPairs']).toBeNull();
    expect(Math.abs((data['volume'] as number) / ((4 / 3) * Math.PI * 1000) - 1)).toBeLessThan(0.002);
    expect(result.data).toMatchObject({ provenance: { engine: 'native' } });
  });

  native('check_mesh passes the same sphere, and an explicit self-intersection search is refused by name', async () => {
    const checked = await applyCommandAsync('check_mesh', { ids: ['scan'], purpose: 'print' });
    expect(checked.error, checked.summary).toBeUndefined();
    expect((checked.data as { meshes: Array<{ triangles: number }> }).meshes[0]?.triangles).toBe(SOURCE_TRIANGLES);
    const refused = await applyCommandAsync('analyze_mesh', { id: 'scan', selfIntersections: true });
    expect(refused.error?.code).toBe('MESH_ENGINE_CAP_EXCEEDED');
    expect(refused.summary).toContain('selfIntersections false');
  });
});
