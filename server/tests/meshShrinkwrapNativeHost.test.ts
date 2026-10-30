/**
 * `shrinkwrap_mesh` on stored meshes through the real host (DES-7c native twins, TECHNICAL_SPEC 13.20): the native engine answers above the TypeScript cap and, between its
 * preference size and that cap, instead of the TypeScript engine; the source AND the target are read at full resolution through the asset store (never their display level of
 * detail); the result goes back through the store; the job reports its stages and honours the timeout. The real binary and the real content-addressed store.
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
import { type ShrinkwrapParams, shrinkwrapMesh } from '@core/geometry/mesh/wrapDisplace';
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

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-mesh-wrap-')), 'cache');

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('meshShrinkwrapNativeHost: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const NDJSON = 'application/x-ndjson';
/** Icosphere level 7 (327,680 triangles): above the 200,000 of the TypeScript engine and the 100,000 kept inline. */
const TRIANGLES = 327_680;

/** The TypeScript oracle on the full meshes (the geometry function: the TypeScript engine itself refuses a target over its 200,000-triangle cap). */
const oracleOf = (params: ShrinkwrapParams): { mesh: MeshData; report: Record<string, unknown> } => {
  const { mesh, ...report } = shrinkwrapMesh(scanMesh, referenceMesh, params);
  return { mesh, report };
};

let server: Server;
let base = '';
let scanMesh: MeshData;
let referenceMesh: MeshData;
let scanKey = '';

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  scanMesh = noisy(icosphere(12, 7), 0.02);
  referenceMesh = noisy(icosphere(10, 7), 0.02);
  scanKey = defaultMeshAssetStore().writeMesh(scanMesh).key;
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A document holding the two stored meshes, each with a tiny display mesh standing for it (the document never holds the 327,680 triangles). */
function documentOfStored(): CadDocument {
  const store = defaultMeshAssetStore();
  const scan = newEntity('mesh', 'scan', { mesh: icosphere(12, 1), asset: store.writeMesh(scanMesh) }, [0, 0, 0], '#cccccc');
  const reference = newEntity('mesh', 'ref', { mesh: icosphere(10, 1), asset: store.writeMesh(referenceMesh) }, [0, 0, 0], '#cccccc');
  return { ...createEmptyDocument(), units: 'mm', entities: { scan, ref: reference }, order: ['scan', 'ref'] };
}

beforeEach(() => {
  _clearResultCache();
  _resetLiveDoc(documentOfStored());
  _resetHistory();
  setMeshProcessingEngine(createNativeMeshEngine({ binary: BINARY as string }));
});

afterEach(() => {
  setMeshProcessingEngine(null);
});

const entityOf = (id: string): MeshSolidEntity => getLiveDoc().entities[id] as MeshSolidEntity;
const post = (name: string, params: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ name, params }),
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as object) },
  });

describe('shrinkwrap_mesh of a 327,680-triangle stored mesh onto a 327,680-triangle stored target', () => {
  native(
    'reads both at full resolution, wraps natively and stores the result: the bytes and the report of the TypeScript engine',
    async () => {
      const result = await applyCommandAsync('shrinkwrap_mesh', { id: 'scan', targetId: 'ref' });
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as Record<string, unknown>;
      expect(data['provenance']).toMatchObject({ engine: 'native', deterministic: true });
      // the input was the stored mesh, not its 80-triangle display level of detail
      expect(data['faces']).toBe(TRIANGLES);
      expect(data['missed']).toBe(0);
      expect(data['moved']).toBeGreaterThan(100_000);
      // the target was the stored mesh too: every wrapped vertex lies on the 327,680-triangle surface (the 80-triangle level would leave them 0.2 off)
      expect(data['residual'] as number).toBeLessThan(1e-9);
      const entity = entityOf('scan');
      expect(entity.asset?.key).not.toBe(scanKey);
      expect(entity.asset?.triangles).toBe(TRIANGLES);
      const stored = defaultMeshAssetStore().readMesh(entity.asset?.key as string) as MeshData;
      const oracle = oracleOf({ mode: 'nearest', offset: 0, side: 'keep' });
      expect(hashOf(stored)).toBe(hashOf(oracle.mesh));
      expect({
        moved: data['moved'],
        missed: data['missed'],
        maxMove: data['maxMove'],
        meanMove: data['meanMove'],
        residual: data['residual'],
      }).toEqual(oracle.report);
      // the target is untouched
      expect(entityOf('ref').asset?.triangles).toBe(TRIANGLES);
    },
    240_000,
  );

  native(
    'the ray modes and an offset keep the oracle bytes; the refusals of the command are the same with the native engine installed',
    async () => {
      const ray = await applyCommandAsync('shrinkwrap_mesh', { id: 'scan', targetId: 'ref', mode: 'normal', offset: 0.1, side: 'outside' });
      expect(ray.error, ray.summary).toBeUndefined();
      const oracle = oracleOf({ mode: 'normal', offset: 0.1, side: 'outside' });
      expect(hashOf(defaultMeshAssetStore().readMesh(entityOf('scan').asset?.key as string) as MeshData)).toBe(hashOf(oracle.mesh));
      _resetLiveDoc(documentOfStored());
      expect((await applyCommandAsync('shrinkwrap_mesh', { id: 'scan', targetId: 'nope' })).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
      expect((await applyCommandAsync('shrinkwrap_mesh', { id: 'scan', targetId: 'scan' })).error?.code).toBe('MESH_PARAM_INVALID');
      expect(entityOf('scan').asset?.key).toBe(scanKey);
    },
    240_000,
  );

  native(
    'streams the stages in order with rising fractions and ends in the result',
    async () => {
      const response = await post('shrinkwrap_mesh', { id: 'scan', targetId: 'ref' }, { headers: { Accept: NDJSON } });
      const lines = (await response.text())
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.at(-1)?.['type']).toBe('result');
      const progress = lines.filter((line) => line['type'] === 'progress' && line['heartbeat'] !== true);
      const stages = progress.map((line) => line['stage'] as string).filter((stage, i, all) => stage !== all[i - 1]);
      // the wrap job, then the deviation job of the command: two runs of read ... write
      expect(stages).toEqual(['start', 'read', 'shrinkwrap', 'write', 'start', 'read', 'deviation', 'write']);
      expect(stages).toContain('shrinkwrap');
      expect(stages.indexOf('read')).toBeLessThan(stages.indexOf('shrinkwrap'));
      let fractions: number[] = [];
      for (const line of progress) {
        if (line['stage'] === 'start' && fractions.length > 0) fractions = [];
        fractions.push(line['fraction'] as number);
        expect(fractions, `rising within a job at ${String(line['stage'])}`).toEqual([...fractions].sort((a, b) => a - b));
      }
      expect(_runningJobCount()).toBe(0);
      expect(liveChildCount()).toBe(0);
    },
    240_000,
  );

  native(
    'LLULL_MESH_OP_TIMEOUT_S ends the job with MESH_TIMEOUT, kills the process and leaves the document',
    async () => {
      setMeshProcessingEngine(
        createNativeMeshEngine({ binary: BINARY as string, env: { ...process.env, LLULL_MESH_OP_TIMEOUT_S: '0.05' } }),
      );
      const before = getLiveDoc();
      const body = (await (await post('shrinkwrap_mesh', { id: 'scan', targetId: 'ref' })).json()) as { error?: { code: string } };
      expect(body.error?.code).toBe('MESH_TIMEOUT');
      expect(getLiveDoc()).toBe(before);
      expect(liveChildCount()).toBe(0);
    },
    240_000,
  );
});

describe('a small mesh onto a large stored target (the cage onto a scan)', () => {
  native(
    'a 5,120-triangle cage wrapped onto the 327,680-triangle stored target is answered natively: the target size routes the op, the TypeScript engine is not asked',
    async () => {
      const doc = documentOfStored();
      const cage = newEntity('mesh', 'cage', { mesh: icosphere(12, 4) }, [0, 0, 0], '#cccccc');
      _resetLiveDoc({ ...doc, entities: { ...doc.entities, cage }, order: [...doc.order, 'cage'] });
      const result = await applyCommandAsync('shrinkwrap_mesh', { id: 'cage', targetId: 'ref' });
      expect(result.error, result.summary).toBeUndefined();
      expect(result.data).toMatchObject({ provenance: { engine: 'native' }, faces: 5_120, missed: 0 });
      expect((result.data as { residual: number }).residual).toBeLessThan(1e-9);
    },
    120_000,
  );
});

describe('between the native preference size and the TypeScript cap', () => {
  native(
    'a mesh the document holds inline goes native above 10,000 triangles and stays in process below',
    async () => {
      const doc = (mesh: MeshData): CadDocument => ({
        ...createEmptyDocument(),
        units: 'mm',
        entities: {
          scan: newEntity('mesh', 'scan', { mesh }, [0, 0, 0], '#cccccc'),
          ref: newEntity('mesh', 'ref', { mesh: icosphere(10, 4) }, [0, 0, 0], '#cccccc'),
        },
        order: ['scan', 'ref'],
      });
      _resetLiveDoc(doc(icosphere(12, 6)));
      const large = await applyCommandAsync('shrinkwrap_mesh', { id: 'scan', targetId: 'ref' });
      expect(large.error, large.summary).toBeUndefined();
      expect(large.data).toMatchObject({ provenance: { engine: 'native' }, faces: 81_920 });
      _resetLiveDoc(doc(icosphere(12, 4)));
      const small = await applyCommandAsync('shrinkwrap_mesh', { id: 'scan', targetId: 'ref' });
      expect(small.error, small.summary).toBeUndefined();
      expect(small.data).toMatchObject({ provenance: { engine: 'ts' }, faces: 5_120 });
    },
    120_000,
  );
});
