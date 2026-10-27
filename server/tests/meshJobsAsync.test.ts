/**
 * Long native mesh jobs on the backend (TECHNICAL_SPEC 13.8), against a fake engine that goes through the real host path: the event loop stays free
 * while a job runs, progress streams in order and ends in the result, a cancelled request kills the job, a repeated commandId joins the running
 * command, a failed job keeps its named code, replay and undo see only the final run.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import type { CadDocument } from '@core/model/types';
import { cuboid, docWithMeshes } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc, getLiveSnapshot } from '../src/liveDocument';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createFakeEngine, type FakeEngine } from './fakeNativeEngine';

const NDJSON = 'application/x-ndjson';
let server: Server;
let base = '';
let fake: FakeEngine;
let source: { doc: CadDocument; id: string };

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
  fake = createFakeEngine(600);
  setMeshProcessingEngine(fake.engine);
  _clearResultCache();
  const { doc, ids } = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
  source = { doc, id: ids[0] as string };
  _resetLiveDoc(doc);
  _resetHistory();
});

afterEach(() => {
  setMeshProcessingEngine(null);
});

const quadRemesh = { name: 'quad_remesh', params: { id: '', targetQuadCount: 6 } };
const post = (body: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    body: JSON.stringify(body),
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  });
const remeshBody = (extra: Record<string, unknown> = {}): unknown => ({
  ...quadRemesh,
  params: { ...quadRemesh.params, id: source.id },
  ...extra,
});
const entityCount = (): number => Object.keys(getLiveDoc().entities).length;

async function ndjsonLines(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the event loop stays free while a native job runs', () => {
  it('serves health, snapshots and another command while quad_remesh runs, then commits the job against the document as it is then', async () => {
    const started = performance.now();
    const remesh = post(remeshBody()).then(async (response) => ({
      body: (await response.json()) as Record<string, unknown>,
      at: performance.now() - started,
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.started()).toBe(1);
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const asked = performance.now();
      const health = await fetch(`${base}/health`);
      latencies.push(performance.now() - asked);
      expect(health.status).toBe(200);
    }
    const box = await post({ name: 'add_box', params: { size: [2, 2, 2] } });
    const boxBody = (await box.json()) as Record<string, unknown>;
    expect(boxBody['isError']).toBe(false);
    const snapshot = (await (await fetch(`${base}/live/snapshot`)).json()) as { document: CadDocument };
    const duringJob = Object.keys(snapshot.document.entities).length;
    expect(duringJob).toBe(2);
    expect(Math.max(...latencies)).toBeLessThan(400);
    const done = await remesh;
    expect(done.at).toBeGreaterThan(450);
    expect(done.body['isError']).toBe(false);
    expect(done.body['affected']).toHaveLength(1);
    expect(entityCount()).toBe(3);
    expect(_runningJobCount()).toBe(0);
    expect(fake.started()).toBe(1);
  });

  it('undo takes the finished command back like any other', async () => {
    const response = await post(remeshBody());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['canUndo']).toBe(true);
    expect(entityCount()).toBe(2);
    const undone = await fetch(`${base}/undo`, { method: 'POST' });
    expect(((await undone.json()) as Record<string, unknown>)['changed']).toBe(true);
    expect(entityCount()).toBe(1);
  });
});

describe('progress streams as NDJSON and ends in the result', () => {
  it('sends progress lines in stage order, then one result line, with the same body the JSON answer has', async () => {
    const response = await post(remeshBody(), { headers: { Accept: NDJSON } });
    expect(response.headers.get('content-type')).toContain(NDJSON);
    const lines = await ndjsonLines(response);
    const progress = lines.filter((line) => line['type'] === 'progress');
    expect(lines.at(-1)?.['type']).toBe('result');
    expect(lines.filter((line) => line['type'] === 'result')).toHaveLength(1);
    expect(lines.indexOf(lines.at(-1) as Record<string, unknown>)).toBe(lines.length - 1);
    const stages = progress.map((line) => line['stage']);
    expect(stages.filter((stage) => stage !== 'start')).toEqual(['stage_1', 'stage_2', 'stage_3', 'stage_4']);
    expect(['start', 'stage_1']).toContain(stages[0]);
    const elapsed = progress.map((line) => line['elapsedMs'] as number);
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
    expect(progress.every((line) => line['op'] === 'quad_remesh' && typeof line['message'] === 'string')).toBe(true);
    const fractions = progress.map((line) => line['fraction']).filter((fraction): fraction is number => typeof fraction === 'number');
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    const result = (lines.at(-1) as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({ isError: false, changed: true, canUndo: true });
    expect((result['affected'] as string[]).length).toBe(1);
  });

  it('a silent job still heartbeats, so a client with an idle timeout keeps waiting', async () => {
    fake = createFakeEngine(700, 1, 100);
    setMeshProcessingEngine(fake.engine);
    const lines = await ndjsonLines(await post(remeshBody(), { headers: { Accept: NDJSON } }));
    const heartbeats = lines.filter((line) => line['heartbeat'] === true);
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)?.['type']).toBe('result');
  });

  it('a command that needs no job answers at once, as a stream of just its result', async () => {
    const lines = await ndjsonLines(await post({ name: 'add_box', params: { size: [1, 1, 1] } }, { headers: { Accept: NDJSON } }));
    expect(lines.map((line) => line['type'])).toEqual(['result']);
  });
});

describe('cancellation', () => {
  it('closing the connection kills the job nobody waits for and applies nothing', async () => {
    const controller = new AbortController();
    const pending = post(remeshBody(), { signal: controller.signal }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(_runningJobCount()).toBe(1);
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.killed()).toBe(1);
    expect(_runningJobCount()).toBe(0);
    expect(getLiveDoc()).toBe(source.doc);
    const again = await post(remeshBody());
    expect(((await again.json()) as Record<string, unknown>)['isError']).toBe(false);
    expect(fake.started()).toBe(2);
  });
});

describe('a repeated commandId while the command still runs', () => {
  it('joins the running command: one job, one entity, the same answer', async () => {
    const [first, second] = await Promise.all([post(remeshBody({ commandId: 'remesh-1' })), post(remeshBody({ commandId: 'remesh-1' }))]);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as [Record<string, unknown>, Record<string, unknown>];
    expect(a['affected']).toEqual(b['affected']);
    expect(fake.started()).toBe(1);
    expect(entityCount()).toBe(2);
  });

  it('refuses the id reused for another command while the first still runs', async () => {
    const first = post(remeshBody({ commandId: 'remesh-2' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const other = await post({ name: 'add_box', params: { size: [1, 1, 1] }, commandId: 'remesh-2' });
    expect(((await other.json()) as Record<string, unknown>)['summary']).toContain('already used for a different command');
    await first;
    expect(entityCount()).toBe(2);
  });
});

describe('a failed job keeps its named code', () => {
  it.each(['MESH_TIMEOUT', 'MESH_QUAD_REMESH_FAILED'])('%s reaches the response, the document is untouched', async (code) => {
    fake.failWith({ code, message: `fake ${code}` });
    const response = await post(remeshBody());
    const body = (await response.json()) as { isError: boolean; error?: { code: string } };
    expect(body.isError).toBe(true);
    expect(body.error?.code).toBe(code);
    expect(getLiveDoc()).toBe(source.doc);
    expect(_runningJobCount()).toBe(0);
  });
});

describe('replay and the recorded history see only the final run', () => {
  it('replay_history after an async command finds the kept result: no second job, same document', async () => {
    await post(remeshBody());
    expect(fake.started()).toBe(1);
    const before = getLiveSnapshot().stateHash;
    const replay = (await (await post({ name: 'replay_history', params: {} })).json()) as Record<string, unknown>;
    expect(replay['isError']).toBe(false);
    expect(fake.started()).toBe(1);
    expect(getLiveSnapshot().stateHash).toBe(before);
  });

  it('a recorded step is in the feature history exactly once', async () => {
    await post(remeshBody());
    const steps = getLiveDoc().featureHistory.filter((step) => step.name === 'quad_remesh');
    expect(steps).toHaveLength(1);
  });
});
