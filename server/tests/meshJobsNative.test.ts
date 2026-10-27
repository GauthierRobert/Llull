/**
 * The real `llull-compute meshops` job behind the backend (TECHNICAL_SPEC 13.8): the event loop answers other requests while it runs, the job's
 * `progress` events arrive in order, a timeout and a crash keep their named codes, a cancelled request kills the process. Native runs need llull-compute
 * (cargo build --release in solver/) and are skipped with a logged reason otherwise; the crash test needs no binary.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import type { MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { docWithMeshes, icosphere } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory, applyCommand } from '../src/commandBus';
import { liveChildCount } from '../src/childProcesses';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshJobsNative: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const NDJSON = 'application/x-ndjson';
/** Icosphere level 6 (81 920 triangles) asked for 5 000 quads: about two seconds of QuadriFlow. */
const SPHERE_LEVEL = 6;

let server: Server;
let base = '';
let meshId = '';

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  _clearResultCache();
  const { doc, ids } = docWithMeshes(icosphere(10, SPHERE_LEVEL));
  meshId = ids[0] as string;
  _resetLiveDoc(doc);
  _resetHistory();
});

afterEach(() => {
  setMeshProcessingEngine(null);
});

const install = (engine: MeshProcessingEngine | null): void => setMeshProcessingEngine(engine);
const remeshBody = (targetQuadCount = 5000): string => JSON.stringify({ name: 'quad_remesh', params: { id: meshId, targetQuadCount } });
const post = (init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}/command`, {
    method: 'POST',
    body: remeshBody(),
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as object) },
  });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a real native job does not block the backend', () => {
  native('answers /health every few milliseconds during quad_remesh, streams the stages in order and ends in the result', async () => {
    install(createNativeMeshEngine({ binary: BINARY as string }));
    const started = performance.now();
    const streaming = post({ headers: { Accept: NDJSON } }).then(async (response) => ({
      text: await response.text(),
      at: performance.now() - started,
    }));
    await sleep(100);
    const latencies: number[] = [];
    let finished = false;
    void streaming.then(() => (finished = true));
    while (!finished) {
      const asked = performance.now();
      await fetch(`${base}/health`);
      latencies.push(performance.now() - asked);
      await sleep(20);
    }
    const { text, at } = await streaming;
    expect(at).toBeGreaterThan(1000);
    expect(latencies.length).toBeGreaterThan(20);
    expect(Math.max(...latencies)).toBeLessThan(1000);
    const lines = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)?.['type']).toBe('result');
    expect((lines.at(-1) as { result: { isError: boolean } }).result.isError).toBe(false);
    const stages = lines
      .filter((line) => line['type'] === 'progress' && line['heartbeat'] !== true)
      .map((line) => line['stage'] as string)
      .filter((stage, i, all) => stage !== all[i - 1]);
    expect(stages).toEqual([
      'start',
      'read',
      'prepare',
      'orientation_field',
      'scale',
      'position_field',
      'integer_constraints',
      'max_flow',
      'fix_flips',
      'final_positions',
      'extract_quads',
      'fix_valence',
      'write',
    ]);
    const fractions = lines.filter((line) => typeof line['fraction'] === 'number').map((line) => line['fraction'] as number);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBeGreaterThanOrEqual(0.9);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(2);
    expect(_runningJobCount()).toBe(0);
    expect(liveChildCount()).toBe(0);
  });

  native('LLULL_MESH_OP_TIMEOUT_S ends the job with MESH_TIMEOUT, kills the process, leaves the document', async () => {
    install(createNativeMeshEngine({ binary: BINARY as string, env: { ...process.env, LLULL_MESH_OP_TIMEOUT_S: '0.3' } }));
    const before = getLiveDoc();
    const body = (await (await post()).json()) as { isError: boolean; error?: { code: string } };
    expect(body.isError).toBe(true);
    expect(body.error?.code).toBe('MESH_TIMEOUT');
    expect(getLiveDoc()).toBe(before);
    expect(liveChildCount()).toBe(0);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  native('closing the connection kills llull-compute and applies nothing', async () => {
    install(createNativeMeshEngine({ binary: BINARY as string }));
    const before = getLiveDoc();
    const controller = new AbortController();
    const pending = post({ signal: controller.signal }).catch((error: unknown) => error);
    await sleep(700);
    expect(liveChildCount()).toBe(1);
    controller.abort();
    await pending;
    await sleep(500);
    expect(liveChildCount()).toBe(0);
    expect(_runningJobCount()).toBe(0);
    expect(getLiveDoc()).toBe(before);
  });

  native('the finished result is kept: the same command again answers without a second job', async () => {
    install(createNativeMeshEngine({ binary: BINARY as string }));
    const first = performance.now();
    await (await post()).json();
    const firstMs = performance.now() - first;
    _resetLiveDoc(getLiveDoc());
    const again = performance.now();
    const body = (await (await post()).json()) as { isError: boolean };
    expect(body.isError).toBe(false);
    expect(performance.now() - again).toBeLessThan(firstMs / 2);
  });

  native('a finished result also answers the synchronous bus (a hit needs no job); a miss there is refused by name', () => {
    install(createNativeMeshEngine({ binary: BINARY as string }));
    const original = getLiveDoc();
    const miss = applyCommand('quad_remesh', { id: meshId, targetQuadCount: 4000 });
    expect(miss).toMatchObject({ changed: false, error: { code: 'MESH_ENGINE_NEEDS_HOST' } });
    expect(getLiveDoc()).toBe(original);
  });

  native('a hit from the kept results is served to the synchronous bus', async () => {
    install(createNativeMeshEngine({ binary: BINARY as string }));
    const original = getLiveDoc();
    await (await post()).json();
    _resetLiveDoc(original);
    _resetHistory();
    const hit = applyCommand('quad_remesh', { id: meshId, targetQuadCount: 5000 });
    expect(hit).toMatchObject({ isError: false, changed: true });
  });
});

describe('a crashed job keeps its named code', () => {
  it('a process that ends without a final event is MESH_QUAD_REMESH_FAILED with NATIVE_PROTOCOL, never a hang', async () => {
    // `node meshops <folder>` exits 1 without printing a single event: the shape of a crash
    install(createNativeMeshEngine({ binary: process.execPath }));
    const before = getLiveDoc();
    const body = (await (await post()).json()) as { isError: boolean; summary: string; error?: { code: string } };
    expect(body.isError).toBe(true);
    expect(body.error?.code).toBe('MESH_QUAD_REMESH_FAILED');
    expect(body.summary).toContain('NATIVE_PROTOCOL');
    expect(getLiveDoc()).toBe(before);
  });
});
