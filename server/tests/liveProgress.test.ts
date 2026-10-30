/**
 * `/live` carries a `progress` event while a command waits for a native mesh job (TECHNICAL_SPEC 13.25): running reports, then `ended` after the command's own
 * `command` event; never a document change (no `seq`, no `stateHash`, nothing in the command log); a TS-only command sends none.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import type { CadDocument } from '@core/model/types';
import { cuboid, docWithMeshes } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveSnapshot } from '../src/liveDocument';
import { _clearResultCache } from '../src/native/deferredRun';
import { createFakeEngine } from './fakeNativeEngine';
import { parseSseFrame } from './sseTestHelpers';

let server: Server;
let base = '';
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
  setMeshProcessingEngine(createFakeEngine(400).engine);
  _clearResultCache();
  const { doc, ids } = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
  source = { doc, id: ids[0] as string };
  _resetLiveDoc(doc);
  _resetHistory();
});
afterEach(() => setMeshProcessingEngine(null));

interface Frame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** An open `/live` subscriber collecting its frames. */
async function subscribe(): Promise<{ frames: Frame[]; close: () => void; settled: () => Promise<void> }> {
  const controller = new AbortController();
  const response = await fetch(`${base}/live`, { signal: controller.signal });
  const frames: Frame[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += new TextDecoder().decode(value);
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) if (part.includes('event: ')) frames.push(parseSseFrame(part));
      }
    } catch {
      // closed by the test
    }
  })();
  const settled = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  return { frames, close: () => controller.abort(), settled };
}

const post = (body: unknown, signal?: AbortSignal): Promise<Response> =>
  fetch(`${base}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
const remesh = (commandId: string): unknown => ({ name: 'quad_remesh', params: { id: source.id, targetQuadCount: 6 }, commandId });

describe('the progress event of /live', () => {
  it('a native job reports running events with the command id, then the command event, then ended; none of them is a document change', async () => {
    const live = await subscribe();
    await live.settled();
    const before = getLiveSnapshot().seq;
    const answer = await (await post(remesh('job-1'))).json();
    await live.settled();
    live.close();
    expect((answer as { changed: boolean }).changed).toBe(true);
    const kinds = live.frames.map((frame) => frame.event);
    const running = live.frames.filter((frame) => frame.event === 'progress' && frame.data['state'] === 'running');
    expect(running.length).toBeGreaterThanOrEqual(3);
    expect(
      running.every(
        (frame) => frame.data['commandId'] === 'job-1' && frame.data['command'] === 'quad_remesh' && frame.data['op'] === 'quad_remesh',
      ),
    ).toBe(true);
    const fractions = running.map((frame) => frame.data['fraction']).filter((fraction): fraction is number => typeof fraction === 'number');
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    const commandAt = kinds.indexOf('command');
    const endedAt = kinds.findIndex((kind, i) => kind === 'progress' && live.frames[i]?.data['state'] === 'ended');
    const lastRunning = kinds.lastIndexOf('progress', commandAt);
    expect(commandAt).toBeGreaterThan(-1);
    expect(lastRunning).toBeLessThan(commandAt);
    expect(endedAt).toBeGreaterThan(commandAt);
    expect(live.frames[endedAt]?.data).toMatchObject({ command: 'quad_remesh', commandId: 'job-1', state: 'ended' });
    // not a document change: no seq / stateHash on a progress frame, and only the command took a sequence number
    for (const frame of live.frames.filter((f) => f.event === 'progress')) {
      expect(frame.data).not.toHaveProperty('seq');
      expect(frame.data).not.toHaveProperty('stateHash');
      expect(typeof frame.data['epoch']).toBe('string');
    }
    expect(live.frames[commandAt]?.data['seq']).toBe(before + 1);
    expect(getLiveSnapshot().seq).toBe(before + 1);
  });

  it('a command that needs no native job sends no progress event at all', async () => {
    const live = await subscribe();
    await live.settled();
    await post({ name: 'add_box', params: { size: [1, 1, 1] } });
    await live.settled();
    live.close();
    expect(live.frames.map((frame) => frame.event)).toEqual(['snapshot', 'command']);
  });

  it('a cancelled job says ended and applies nothing', async () => {
    setMeshProcessingEngine(createFakeEngine(800).engine);
    const live = await subscribe();
    await live.settled();
    const cancel = new AbortController();
    const pending = post(remesh('job-2'), cancel.signal).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 250));
    cancel.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 400));
    live.close();
    const kinds = live.frames.map((frame) => frame.event);
    expect(kinds).not.toContain('command');
    const ended = live.frames.filter((frame) => frame.event === 'progress' && frame.data['state'] === 'ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.data['commandId']).toBe('job-2');
    expect(kinds.indexOf('progress')).toBeLessThan(kinds.lastIndexOf('progress'));
  });

  it('two requests of one command without a command id get two job ids, each ended on its own', async () => {
    const live = await subscribe();
    await live.settled();
    const bare = { name: 'quad_remesh', params: { id: source.id, targetQuadCount: 6 } };
    await Promise.all([post(bare), post(bare)]);
    await live.settled();
    live.close();
    const progress = live.frames.filter((frame) => frame.event === 'progress');
    const jobs = new Set(progress.map((frame) => frame.data['jobId']));
    expect(jobs.size).toBe(2);
    expect([...jobs].every((job) => typeof job === 'string' && (job as string).startsWith('req-'))).toBe(true);
    for (const job of jobs) {
      const own = progress.filter((frame) => frame.data['jobId'] === job);
      expect(own.at(-1)?.data['state']).toBe('ended');
      expect(own.filter((frame) => frame.data['state'] === 'ended')).toHaveLength(1);
      expect(own.every((frame) => frame.data['commandId'] === undefined)).toBe(true);
    }
  });
});
