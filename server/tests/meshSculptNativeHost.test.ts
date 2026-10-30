/**
 * `sculpt_mesh` on stored meshes through the real host (DES-7c step 7, slice 3, TECHNICAL_SPEC 13.14): the native engine answers above the TypeScript cap and, between
 * its preference size and that cap, instead of the TypeScript engine; the input is read at full resolution through the asset store; the result goes back through the
 * store; the job reports its stages and honours cancellation and the timeout (13.8). The real binary and the real content-addressed store.
 * Native runs need llull-compute (cargo build --release in solver/) and are skipped with a logged reason otherwise.
 */

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { type CadDocument, createEmptyDocument, type MeshData, type MeshSolidEntity } from '@core/model/types';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { liveChildCount } from '../src/childProcesses';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { hashOf, noisy } from './meshopsNativeSupport';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-mesh-sculpt-')), 'cache');

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshSculptNativeHost: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const NDJSON = 'application/x-ndjson';
/** Icosphere level 7 (327,680 triangles): above the 200,000 of the TypeScript engine and the 100,000 kept inline. */
const SOURCE_TRIANGLES = 327_680;
const STAMPS = [{ center: [0, 0, 10] }, { center: [2, 1, 9.6] }];

let server: Server;
let base = '';
let scanMesh: MeshData;
let sourceKey = '';

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  scanMesh = noisy(icosphere(10, 7), 0.02);
  sourceKey = defaultMeshAssetStore().writeMesh(scanMesh).key;
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A document holding the stored mesh as `scan`, with a tiny display mesh standing for it (the document never holds the 327,680 triangles). */
function scanDocument(): CadDocument {
  const reference = defaultMeshAssetStore().writeMesh(scanMesh);
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

const stroke = { id: 'scan', brush: 'draw', stamps: STAMPS, radius: 3, strength: 0.4, symmetry: { plane: 'yz' } } as const;

describe('sculpt_mesh of a 327,680-triangle stored mesh', () => {
  native(
    'reads the full-resolution input, sculpts it natively and stores the result: the bytes of the TypeScript engine',
    async () => {
      const result = await applyCommandAsync('sculpt_mesh', stroke);
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as Record<string, unknown>;
      expect(data['provenance']).toMatchObject({ engine: 'native', deterministic: true });
      // the input was the stored mesh, not its 80-triangle display level of detail
      expect(data['faces']).toBe(SOURCE_TRIANGLES);
      expect(data['stampsApplied']).toBe(4);
      expect(data['movedVertices']).toBeGreaterThan(500);
      // no vertex of a noisy scan has a mirror partner within the tolerance
      expect(data['symmetryError']).toBeNull();
      const entity = scan();
      expect(entity.asset?.key).not.toBe(sourceKey);
      expect(entity.asset?.triangles).toBe(SOURCE_TRIANGLES);
      const stored = defaultMeshAssetStore().readMesh(entity.asset?.key as string) as MeshData;
      // the oracle on the same input (the engine called directly: its cap is not applied)
      const oracle = tsMeshEngine.run(
        { mesh: scanMesh },
        {
          op: 'sculpt',
          brush: 'draw',
          stamps: STAMPS.map((stamp) => stamp.center) as [number, number, number][],
          radius: 3,
          strength: 0.4,
          falloff: 'smooth',
          direction: 'area_normal',
          taubin: false,
          symmetry: 'yz',
        },
      );
      expect('mesh' in oracle).toBe(true);
      expect(hashOf(stored)).toBe(hashOf((oracle as { mesh: MeshData }).mesh));
      expect(data['movedVertices']).toBe((oracle as { report: Record<string, unknown> }).report['movedVertices']);
    },
    120_000,
  );

  native(
    'refinement grows the stored mesh by two triangles per split and a stamp off the surface is refused with the TypeScript wording',
    async () => {
      const refined = await applyCommandAsync('sculpt_mesh', { ...stroke, refineEdge: 0.04, radius: 1.5, symmetry: undefined });
      expect(refined.error, refined.summary).toBeUndefined();
      const data = refined.data as { faces: number; refinedEdges: number };
      expect(data.refinedEdges).toBeGreaterThan(0);
      expect(data.faces).toBe(SOURCE_TRIANGLES + 2 * data.refinedEdges);
      _resetLiveDoc(scanDocument());
      const off = await applyCommandAsync('sculpt_mesh', {
        id: 'scan',
        brush: 'draw',
        stamps: [{ center: [0, 0, 10] }, { center: [0, 0, 30] }],
        radius: 3,
        strength: 1,
      });
      expect(off.error?.code).toBe('MESH_SCULPT_STAMP_OFF_SURFACE');
      expect(off.summary).toContain('stamp 1 is farther than the radius 3 from the mesh surface');
      const tooLarge = await applyCommandAsync('sculpt_mesh', {
        id: 'scan',
        brush: 'draw',
        stamps: STAMPS,
        radius: 4,
        strength: 1,
        refineEdge: 1e-5,
      });
      expect(tooLarge.error?.code).toBe('MESH_SCULPT_RESULT_TOO_LARGE');
      expect(scan().asset?.key).toBe(sourceKey);
    },
    120_000,
  );

  native(
    'streams the stages in order with rising fractions and ends in the result',
    async () => {
      const response = await post('sculpt_mesh', stroke, { headers: { Accept: NDJSON } });
      const lines = (await response.text())
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.at(-1)?.['type']).toBe('result');
      const progress = lines.filter((line) => line['type'] === 'progress' && line['heartbeat'] !== true);
      const stages = progress.map((line) => line['stage'] as string).filter((stage, i, all) => stage !== all[i - 1]);
      expect(stages.slice(-3)).toEqual(['read', 'sculpt', 'write']);
      const fractions = progress.map((line) => line['fraction'] as number);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(_runningJobCount()).toBe(0);
      expect(liveChildCount()).toBe(0);
    },
    120_000,
  );

  native(
    'LLULL_MESH_OP_TIMEOUT_S ends the job with MESH_TIMEOUT, kills the process and leaves the document',
    async () => {
      setMeshProcessingEngine(
        createNativeMeshEngine({ binary: BINARY as string, env: { ...process.env, LLULL_MESH_OP_TIMEOUT_S: '0.05' } }),
      );
      const before = getLiveDoc();
      const body = (await (await post('sculpt_mesh', stroke)).json()) as { error?: { code: string } };
      expect(body.error?.code).toBe('MESH_TIMEOUT');
      expect(getLiveDoc()).toBe(before);
      expect(liveChildCount()).toBe(0);
    },
    120_000,
  );

  native(
    'closing the connection kills llull-compute and applies nothing',
    async () => {
      const before = getLiveDoc();
      const controller = new AbortController();
      // many stamps and a refinement keep the job running while the connection closes
      const long = {
        ...stroke,
        stamps: Array.from({ length: 400 }, (_, i) => ({ center: [Math.sin(i / 20) * 4, Math.cos(i / 20) * 2, 9.3] })),
        refineEdge: 0.35,
      };
      const pending = post('sculpt_mesh', long, { signal: controller.signal }).catch((error: unknown) => error);
      await waitForChild(30_000);
      expect(liveChildCount()).toBe(1);
      controller.abort();
      await pending;
      // the process tree dies asynchronously (slower under load): wait on the observable, bounded
      for (let waited = 0; waited < 10_000 && liveChildCount() > 0; waited += 50) await sleep(50);
      expect(liveChildCount()).toBe(0);
      expect(_runningJobCount()).toBe(0);
      expect(getLiveDoc()).toBe(before);
    },
    120_000,
  );
});

describe('between the native preference size and the TypeScript cap', () => {
  native(
    'a mesh the document holds inline goes native above 15,000 triangles and stays in process below',
    async () => {
      const doc = (mesh: MeshData): CadDocument => ({
        ...createEmptyDocument(),
        units: 'mm',
        entities: { scan: newEntity('mesh', 'scan', { mesh }, [0, 0, 0], '#cccccc') },
        order: ['scan'],
      });
      _resetLiveDoc(doc(icosphere(10, 6)));
      const large = await applyCommandAsync('sculpt_mesh', { id: 'scan', brush: 'inflate', stamps: STAMPS, radius: 3, strength: 0.3 });
      expect(large.error, large.summary).toBeUndefined();
      expect(large.data).toMatchObject({ provenance: { engine: 'native' }, faces: 81_920 });
      _resetLiveDoc(doc(icosphere(10, 4)));
      const small = await applyCommandAsync('sculpt_mesh', { id: 'scan', brush: 'inflate', stamps: STAMPS, radius: 3, strength: 0.3 });
      expect(small.error, small.summary).toBeUndefined();
      expect(small.data).toMatchObject({ provenance: { engine: 'ts' }, faces: 5_120 });
    },
    120_000,
  );
});
