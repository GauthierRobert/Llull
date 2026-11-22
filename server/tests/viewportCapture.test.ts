/** ASC M6a capture_viewport on the backend: fake renderer client, request -> frame -> the command re-runs with the image; stale documents; timeout; no client; hostile frames. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { answerFrame, registerRenderer, type CaptureEvent, type RendererMessage } from '../src/viewport/captureBroker';
import { answerOfBody } from '../src/viewport/captureRoutes';
import { encodePng } from '@lib/png';
import { documentHash } from '@protocol/liveSync';

const pngOf = (width: number, height: number): Buffer => Buffer.from(encodePng(width, height, new Uint8Array(width * height * 4)));
const leaveAll: (() => void)[] = [];

interface FakeRenderer {
  readonly events: CaptureEvent[];
  readonly cancelled: string[];
}

/** A fake desktop renderer: records the messages it is sent and answers each capture with `reply`. */
function fakeRenderer(reply: (event: CaptureEvent) => void): FakeRenderer {
  const seen: FakeRenderer = { events: [], cancelled: [] };
  leaveAll.push(
    registerRenderer((message: RendererMessage) => {
      if (message.type === 'cancel') return void seen.cancelled.push(message.id);
      seen.events.push(message.event);
      queueMicrotask(() => reply(message.event));
    }),
  );
  return seen;
}

const answerWithFrame = (event: CaptureEvent): void => {
  answerFrame(event.id, { frame: { png: new Uint8Array(pngOf(event.request.width, event.request.height)), ...event.request } });
};

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

afterEach(() => {
  delete process.env['LLULL_VIEWPORT_TIMEOUT_MS'];
  for (const leave of leaveAll.splice(0)) leave();
});

describe('capture_viewport through the backend', () => {
  it('no renderer connected: VIEWPORT_UNAVAILABLE', async () => {
    const result = await applyCommandAsync('capture_viewport', {});
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('VIEWPORT_UNAVAILABLE');
  });

  it('asks the renderer once with the hash of the document, then re-runs the command with the frame; the document is unchanged', async () => {
    const before = getLiveDoc();
    const seen = fakeRenderer(answerWithFrame);
    const result = await applyCommandAsync('capture_viewport', { view: 'front', width: 320, height: 200 });
    expect(result.isError).toBe(false);
    expect(result.changed).toBe(false);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.request).toMatchObject({ view: 'front', width: 320, height: 200, zoom: 1, hideLayers: [] });
    expect(seen.events[0]?.documentHash).toBe(documentHash(before));
    const data = result.data as { image: string; width: number; height: number };
    expect(Buffer.from(data.image, 'base64')).toEqual(pngOf(320, 200));
    expect([data.width, data.height]).toEqual([320, 200]);
    expect(getLiveDoc()).toBe(before);
  });

  it('a capture after a change is a new frame of the new state (never the earlier one)', async () => {
    const seen = fakeRenderer(answerWithFrame);
    await applyCommandAsync('capture_viewport', { width: 64, height: 64 });
    await applyCommandAsync('add_box', { size: [1, 1, 1] });
    await applyCommandAsync('capture_viewport', { width: 64, height: 64 });
    expect(seen.events).toHaveLength(2);
    expect(seen.events[0]?.documentHash).not.toBe(seen.events[1]?.documentHash);
  });

  it('inside a plan after a mutating step the run document is not the one the viewport shows: VIEWPORT_STALE, the renderer is never asked', async () => {
    const seen = fakeRenderer(answerWithFrame);
    const result = await applyCommandAsync('build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'capture_viewport', params: { width: 64, height: 64 } },
      ],
      onError: 'continue',
    });
    expect(JSON.stringify(result)).toContain('VIEWPORT_STALE');
    expect(seen.events).toEqual([]);
  });

  it('the renderer reports it cannot draw: its code and message are kept', async () => {
    fakeRenderer((event) => answerFrame(event.id, { code: 'VIEWPORT_STALE', message: 'live sync is behind' }));
    const result = await applyCommandAsync('capture_viewport', {});
    expect(result.error?.code).toBe('VIEWPORT_STALE');
    expect(result.summary).toContain('behind');
  });

  it('a renderer that never answers: VIEWPORT_TIMEOUT, and it is told to drop the frame', async () => {
    process.env['LLULL_VIEWPORT_TIMEOUT_MS'] = '40';
    const seen = fakeRenderer(() => undefined);
    const result = await applyCommandAsync('capture_viewport', {});
    expect(result.error?.code).toBe('VIEWPORT_TIMEOUT');
    expect(seen.cancelled).toEqual([seen.events[0]?.id]);
  });

  it('a renderer that disconnects while a frame is asked: VIEWPORT_UNAVAILABLE; with another one connected the request moves to it', async () => {
    let leave: () => void = () => undefined;
    leave = registerRenderer(() => queueMicrotask(() => leave()));
    expect((await applyCommandAsync('capture_viewport', {})).error?.code).toBe('VIEWPORT_UNAVAILABLE');

    const fallback = fakeRenderer(answerWithFrame);
    let leaveNewest: () => void = () => undefined;
    leaveNewest = registerRenderer(() => queueMicrotask(() => leaveNewest()));
    const result = await applyCommandAsync('capture_viewport', { width: 64, height: 64 });
    expect(result.isError).toBe(false);
    expect(fallback.events).toHaveLength(1);
  });

  it('cancelling the request stops waiting, tells the renderer and commits nothing', async () => {
    const seen = fakeRenderer(() => undefined);
    const cancel = new AbortController();
    const pending = applyCommandAsync('capture_viewport', {}, { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 20);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.changed).toBe(false);
    expect(seen.cancelled).toEqual([seen.events[0]?.id]);
  });
});

describe('POST /viewport/frame/:id', () => {
  it('delivers the renderer frame to the waiting command (POST /command round trip)', async () => {
    const png = pngOf(64, 64);
    fakeRenderer((event) => {
      void request(app)
        .post(`/viewport/frame/${event.id}`)
        .send({ png: png.toString('base64'), width: 64, height: 64 })
        .then((response) => expect(response.status).toBe(200));
    });
    const response = await request(app)
      .post('/command')
      .send({ name: 'capture_viewport', params: { width: 64, height: 64 } });
    expect(response.status).toBe(200);
    expect(response.body.isError).toBe(false);
    expect(Buffer.from(response.body.data.image, 'base64')).toEqual(png);
  });

  it('an unknown or late id is 404 before its body is read', async () => {
    const huge = 'A'.repeat(3 * 1024 * 1024);
    const response = await request(app).post('/viewport/frame/nobody').send({ png: huge, width: 8, height: 8 });
    expect(response.status).toBe(404);
  });

  it('a picture that is not a PNG of the asked size is 400 and ends the request VIEWPORT_CAPTURE_FAILED', async () => {
    const wrongSize = pngOf(32, 32);
    fakeRenderer((event) => {
      void request(app)
        .post(`/viewport/frame/${event.id}`)
        .send({ png: wrongSize.toString('base64'), width: 64, height: 64 })
        .then((response) => expect(response.status).toBe(400));
    });
    const result = await request(app)
      .post('/command')
      .send({ name: 'capture_viewport', params: { width: 64, height: 64 } });
    expect(result.body.error?.code).toBe('VIEWPORT_CAPTURE_FAILED');
  });

  it('a body larger than the asked size can reach is refused (413)', async () => {
    fakeRenderer((event) => {
      void request(app)
        .post(`/viewport/frame/${event.id}`)
        .send({ png: 'A'.repeat(1024 * 1024), width: 64, height: 64 })
        .then((response) => {
          expect(response.status).toBe(413);
          answerFrame(event.id, { code: 'VIEWPORT_CAPTURE_FAILED', message: 'done' });
        });
    });
    await request(app)
      .post('/command')
      .send({ name: 'capture_viewport', params: { width: 64, height: 64 } });
  });
});

describe('GET /viewport/stream', () => {
  it('needs a token when the backend has none and was not launched insecure', async () => {
    const token = process.env['LLULL_AUTH_TOKEN'];
    const insecure = process.env['LLULL_INSECURE_NO_TOKEN'];
    delete process.env['LLULL_AUTH_TOKEN'];
    delete process.env['LLULL_INSECURE_NO_TOKEN'];
    try {
      expect((await request(app).get('/viewport/stream')).status).toBe(401);
    } finally {
      if (token !== undefined) process.env['LLULL_AUTH_TOKEN'] = token;
      if (insecure !== undefined) process.env['LLULL_INSECURE_NO_TOKEN'] = insecure;
    }
  });
});

describe('answerOfBody', () => {
  const asked = { width: 2, height: 3 };
  it('reads a frame of the asked size and an error, and refuses everything else', () => {
    expect(answerOfBody({ png: pngOf(2, 3).toString('base64'), width: 2, height: 3 }, asked)).toMatchObject({
      frame: { width: 2, height: 3 },
    });
    expect(answerOfBody({ error: { message: 'm' } }, asked)).toEqual({ code: 'VIEWPORT_CAPTURE_FAILED', message: 'm' });
    expect(answerOfBody({ error: { code: 'VIEWPORT_TIMEOUT', message: 'm' } }, asked)).toMatchObject({ code: 'VIEWPORT_TIMEOUT' });
    expect(answerOfBody({ error: { code: 'OTHER', message: 'm' } }, asked)).toMatchObject({ code: 'VIEWPORT_CAPTURE_FAILED' });
    const good = pngOf(2, 3).toString('base64');
    for (const body of [
      null,
      5,
      {},
      { png: good, width: 3, height: 2 }, // declared size is not the asked one
      { png: pngOf(3, 2).toString('base64'), width: 2, height: 3 }, // IHDR is not the declared one
      { png: Buffer.from('not a png at all, just some text bytes').toString('base64'), width: 2, height: 3 },
      { png: 'AAAA', width: 2, height: 3 },
      { png: '', width: 2, height: 3 },
      { png: good, width: '2', height: 3 },
    ])
      expect(answerOfBody(body, asked)).toBeNull();
  });
});
