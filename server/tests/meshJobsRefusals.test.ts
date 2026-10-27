/**
 * What a native mesh job must never do to the document (TECHNICAL_SPEC 13.8): a cancelled command commits nothing, however many steps it had done; a
 * plan of many native steps resolves one job per round; a joined commandId follows all its requests; /preview waits for a job without blocking; the
 * synchronous bus refuses a native op by name. A fake engine on the real host path.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import type { CadDocument } from '@core/model/types';
import { cuboid, docWithMeshes } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory, applyCommand, applyCommandAsync, canUndo } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc, subscribeLive } from '../src/liveDocument';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { createFakeEngine, type FakeEngine } from './fakeNativeEngine';
import { makeFakeRes } from './sseTestHelpers';

let fake: FakeEngine;
let source: { doc: CadDocument; id: string };

beforeEach(() => {
  fake = createFakeEngine(400, 2);
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

const remesh = (targetQuadCount: number): Record<string, unknown> => ({ id: source.id, targetQuadCount });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const commandFrames = (written: string[]): number => written.filter((frame) => frame.startsWith('event: command')).length;
/** The live document after one finished quad_remesh, and the id of that step. */
async function withRemeshStep(): Promise<string> {
  await applyCommandAsync('quad_remesh', remesh(6));
  _clearResultCache();
  return (getLiveDoc().featureHistory.find((step) => step.name === 'quad_remesh') as { id: string }).id;
}

describe('a cancelled command commits nothing', () => {
  it('a history edit upstream of a native step: no document change, no undo entry, no live event, the refusal names MESH_CANCELLED', async () => {
    const stepId = await withRemeshStep();
    const before = getLiveDoc();
    const undoable = canUndo();
    const watcher = makeFakeRes();
    const unsubscribe = subscribeLive(watcher);
    const frames = commandFrames(watcher.written);
    const controller = new AbortController();
    const running = applyCommandAsync('edit_step_params', { stepId, params: remesh(7) }, { signal: controller.signal });
    await sleep(100);
    expect(_runningJobCount()).toBe(1);
    controller.abort();
    const answer = await running;
    unsubscribe();
    expect(answer).toMatchObject({ changed: false, isError: true, error: { code: 'MESH_CANCELLED' } });
    expect(getLiveDoc()).toBe(before);
    expect(canUndo()).toBe(undoable);
    expect(commandFrames(watcher.written)).toBe(frames);
    expect(fake.killed()).toBe(1);
  });

  it('a plan with onError continue does not apply the steps that did not need the job', async () => {
    const before = getLiveDoc();
    const watcher = makeFakeRes();
    const unsubscribe = subscribeLive(watcher);
    const controller = new AbortController();
    const actions = [
      { command: 'quad_remesh', params: remesh(6) },
      { command: 'add_box', params: { size: [2, 2, 2] } },
    ];
    const running = applyCommandAsync('build_project', { actions, onError: 'continue' }, { signal: controller.signal });
    await sleep(100);
    controller.abort();
    const answer = await running;
    unsubscribe();
    expect(answer).toMatchObject({ changed: false, error: { code: 'MESH_CANCELLED' } });
    expect(getLiveDoc()).toBe(before);
    expect(commandFrames(watcher.written)).toBe(0);
  });

  it('its commandId keeps no result: the same id runs again', async () => {
    const controller = new AbortController();
    const first = applyCommandAsync('quad_remesh', remesh(6), { commandId: 'cancel-1', signal: controller.signal });
    await sleep(100);
    controller.abort();
    expect((await first).changed).toBe(false);
    const again = await applyCommandAsync('quad_remesh', remesh(6), { commandId: 'cancel-1' });
    expect(again).toMatchObject({ changed: true, isError: false });
    expect(fake.started()).toBe(2);
  });
});

describe('a plan of many native steps', () => {
  it('resolves one job per step: 19 native steps, none refused by a run bound', async () => {
    fake = createFakeEngine(2, 1);
    setMeshProcessingEngine(fake.engine);
    const actions = Array.from({ length: 19 }, (_, i) => ({ command: 'quad_remesh', params: remesh(6 + i) }));
    const answer = await applyCommandAsync('build_project', { actions });
    expect(answer).toMatchObject({ isError: false, changed: true });
    expect(fake.started()).toBe(19);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(20);
  });

  it('a replay with two native steps asks for one job at a time', async () => {
    fake = createFakeEngine(600, 1);
    setMeshProcessingEngine(fake.engine);
    await applyCommandAsync('quad_remesh', remesh(6));
    await applyCommandAsync('quad_remesh', remesh(7));
    _clearResultCache();
    const startedBefore = fake.started();
    const running = applyCommandAsync('replay_history', {});
    await sleep(200);
    expect(fake.started() - startedBefore).toBe(1);
    expect(await running).toMatchObject({ isError: false });
    expect(fake.started() - startedBefore).toBe(2);
  });
});

describe('a commandId that several requests joined', () => {
  it('survives the abort of one request and is aborted when every request has aborted', async () => {
    const [one, two] = [new AbortController(), new AbortController()];
    const first = applyCommandAsync('quad_remesh', remesh(6), { commandId: 'joined', signal: one.signal });
    const second = applyCommandAsync('quad_remesh', remesh(6), { commandId: 'joined', signal: two.signal });
    await sleep(100);
    one.abort();
    await sleep(100);
    expect(fake.killed()).toBe(0);
    expect(await second).toMatchObject({ changed: true });
    await first;

    _clearResultCache();
    const [three, four] = [new AbortController(), new AbortController()];
    const third = applyCommandAsync('quad_remesh', remesh(7), { commandId: 'joined-2', signal: three.signal });
    const fourth = applyCommandAsync('quad_remesh', remesh(7), { commandId: 'joined-2', signal: four.signal });
    await sleep(100);
    three.abort();
    four.abort();
    expect(await third).toMatchObject({ changed: false, error: { code: 'MESH_CANCELLED' } });
    expect(await fourth).toMatchObject({ changed: false });
    expect(fake.killed()).toBe(1);
    expect(_runningJobCount()).toBe(0);
  });

  it('does not join a command whose requests have all left: it runs fresh once the cancelled one has settled', async () => {
    const leaving = new AbortController();
    const first = applyCommandAsync('quad_remesh', remesh(6), { commandId: 'rejoin', signal: leaving.signal });
    await sleep(100);
    leaving.abort();
    const second = applyCommandAsync('quad_remesh', remesh(6), { commandId: 'rejoin' });
    expect(await first).toMatchObject({ changed: false, error: { code: 'MESH_CANCELLED' } });
    expect(await second).toMatchObject({ changed: true, isError: false });
    expect(fake.started()).toBe(2);
  });

  it('a request without a signal keeps the command alive; resetting the bus forgets the running ids', async () => {
    const quitter = new AbortController();
    const leaves = applyCommandAsync('quad_remesh', remesh(6), { commandId: 'stays', signal: quitter.signal });
    const stays = applyCommandAsync('quad_remesh', remesh(6), { commandId: 'stays' });
    await sleep(100);
    quitter.abort();
    expect(await stays).toMatchObject({ changed: true });
    await leaves;
    const pending = applyCommandAsync('quad_remesh', remesh(7), { commandId: 'forgotten' });
    await sleep(50);
    _resetHistory();
    const started = fake.started();
    const duplicate = applyCommandAsync('quad_remesh', remesh(7), { commandId: 'forgotten' });
    await sleep(50);
    expect(fake.started()).toBe(started);
    await Promise.all([pending, duplicate]);
  });
});

describe('/preview and the synchronous bus', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const preview = (signal?: AbortSignal): Promise<Response> =>
    fetch(`${base}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'quad_remesh', params: remesh(6) }),
      ...(signal !== undefined ? { signal } : {}),
    });

  it('waits for the job without blocking the backend, and applies nothing', async () => {
    const before = getLiveDoc();
    const answering = preview().then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    }));
    await sleep(100);
    const asked = performance.now();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(performance.now() - asked).toBeLessThan(400);
    const { status, body } = await answering;
    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('MESH_ENGINE_PENDING');
    expect(fake.started()).toBe(1);
    expect(getLiveDoc()).toBe(before);
  });

  it('a client that closes the connection cancels the preview and the job', async () => {
    const controller = new AbortController();
    const pending = preview(controller.signal).catch((error: unknown) => error);
    await sleep(100);
    controller.abort();
    await pending;
    await sleep(150);
    expect(fake.killed()).toBe(1);
    expect(_runningJobCount()).toBe(0);
  });

  it('the synchronous applyCommand refuses a native op by name instead of blocking', () => {
    setMeshProcessingEngine(createNativeMeshEngine({ binary: process.execPath }));
    const before = getLiveDoc();
    const answer = applyCommand('quad_remesh', remesh(6));
    expect(answer).toMatchObject({ changed: false, error: { code: 'MESH_ENGINE_NEEDS_HOST' } });
    expect(getLiveDoc()).toBe(before);
  });
});
