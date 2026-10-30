/**
 * `analyze_mesh` and `check_mesh` with the pair search on a stored mesh above the TypeScript cap through the real host (DES-7c step 7, slice 4, TECHNICAL_SPEC 13.15.2):
 * the native engine searches the crossing pairs at full resolution (before slice 4 it refused the search), the job reports the stage, honours cancellation and the
 * timeout. The real binary and the real content-addressed store. Native runs need llull-compute (cargo build --release in solver/).
 */

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { type CadDocument, createEmptyDocument, type MeshData } from '@core/model/types';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { liveChildCount } from '../src/childProcesses';
import { _resetLiveDoc } from '../src/liveDocument';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-mesh-pairs-')), 'cache');

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshPairsNativeHost: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const NDJSON = 'application/x-ndjson';
/** Icosphere level 7 (327,680 triangles) with a small sphere (1,280) pushed through its skin: above the 200,000 of the TypeScript engine. */
const SOURCE_TRIANGLES = 327_680 + 1_280;

let server: Server;
let base = '';
let scanMesh: MeshData;

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const big = icosphere(10, 7);
  const small = icosphere(3, 3);
  const offset = big.positions.length / 3;
  scanMesh = {
    positions: big.positions.concat(small.positions.map((v, i) => (i % 3 === 2 ? v + 10 : v))),
    indices: big.indices.concat(small.indices.map((v) => v + offset)),
  };
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

describe('the pair search of analyze_mesh and check_mesh on 328,960 stored triangles', () => {
  native(
    'analyze_mesh finds the pairs at full resolution by default, natively',
    async () => {
      const result = await applyCommandAsync('analyze_mesh', { id: 'scan', maxListed: 5 });
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as {
        faces: number;
        selfIntersectionPairs: number;
        selfIntersections: number[][];
        provenance: { engine: string };
      };
      expect(data.provenance.engine).toBe('native');
      expect(data.faces).toBe(SOURCE_TRIANGLES);
      expect(data.selfIntersectionPairs).toBeGreaterThan(10);
      expect(data.selfIntersections).toHaveLength(5);
      // every listed pair is one face of each sphere: the faces of the small sphere come after those of the big one
      expect(data.selfIntersections.every(([low, high]) => (low as number) < 327_680 && (high as number) >= 327_680)).toBe(true);
      const off = await applyCommandAsync('analyze_mesh', { id: 'scan', selfIntersections: false });
      expect(off.data).toMatchObject({ selfIntersectionPairs: null });
    },
    120_000,
  );

  native(
    'check_mesh reports the overlap as a finding',
    async () => {
      const checked = await applyCommandAsync('check_mesh', { ids: ['scan'], purpose: 'print' });
      expect(checked.error, checked.summary).toBeUndefined();
      const findings = (checked.data as { findings: Array<{ code: string; value: number }> }).findings;
      expect(findings.find((f) => f.code === 'MESH_CHECK_SELF_OVERLAP')?.value).toBeGreaterThan(10);
    },
    120_000,
  );

  native(
    'streams the stages in order with rising fractions, the pair search among them',
    async () => {
      const response = await post('analyze_mesh', { id: 'scan' }, { headers: { Accept: NDJSON } });
      const lines = (await response.text())
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.at(-1)?.['type']).toBe('result');
      const progress = lines.filter((line) => line['type'] === 'progress' && line['heartbeat'] !== true);
      const stages = progress.map((line) => line['stage'] as string).filter((stage, i, all) => stage !== all[i - 1]);
      expect(stages.slice(-4)).toEqual(['read', 'analyze', 'self_intersections', 'write']);
      const fractions = progress.map((line) => line['fraction'] as number);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(_runningJobCount()).toBe(0);
      expect(liveChildCount()).toBe(0);
    },
    120_000,
  );

  native(
    'LLULL_MESH_OP_TIMEOUT_S ends the job with MESH_TIMEOUT and kills the process',
    async () => {
      setMeshProcessingEngine(
        createNativeMeshEngine({ binary: BINARY as string, env: { ...process.env, LLULL_MESH_OP_TIMEOUT_S: '0.05' } }),
      );
      const body = (await (await post('analyze_mesh', { id: 'scan' })).json()) as { error?: { code: string } };
      expect(body.error?.code).toBe('MESH_TIMEOUT');
      expect(liveChildCount()).toBe(0);
    },
    120_000,
  );

  native(
    'closing the connection kills llull-compute',
    async () => {
      const controller = new AbortController();
      const pending = post('analyze_mesh', { id: 'scan' }, { signal: controller.signal }).catch((error) => error);
      await waitForChild(30_000);
      expect(liveChildCount()).toBe(1);
      controller.abort();
      await pending;
      await sleep(500);
      expect(liveChildCount()).toBe(0);
      expect(_runningJobCount()).toBe(0);
    },
    120_000,
  );
});
