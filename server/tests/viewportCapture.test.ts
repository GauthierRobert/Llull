/** ASC M6a capture_viewport on the backend: fake renderer client, request -> frame -> the command re-runs with the image; timeout; no client. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { answerFrame, registerRenderer, type CaptureEvent } from '../src/viewport/captureBroker';
import { answerOfBody } from '../src/viewport/captureRoutes';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
const leaveAll: (() => void)[] = [];

/** A fake desktop renderer: records the events it is sent and answers them with `reply`. */
function fakeRenderer(reply: (event: CaptureEvent) => void): CaptureEvent[] {
  const events: CaptureEvent[] = [];
  leaveAll.push(
    registerRenderer((event) => {
      events.push(event);
      queueMicrotask(() => reply(event));
    }),
  );
  return events;
}

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

  it('asks the renderer once, then re-runs the command with the frame; the document is unchanged', async () => {
    const before = getLiveDoc();
    const events = fakeRenderer((event) =>
      answerFrame(event.id, { frame: { png: new Uint8Array(PNG), width: event.request.width, height: event.request.height } }),
    );
    const result = await applyCommandAsync('capture_viewport', { view: 'front', width: 320, height: 200 });
    expect(result.isError).toBe(false);
    expect(result.changed).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.request).toMatchObject({ view: 'front', width: 320, height: 200, zoom: 1, hideLayers: [] });
    const data = result.data as { image: string; width: number; height: number };
    expect(Buffer.from(data.image, 'base64')).toEqual(PNG);
    expect([data.width, data.height]).toEqual([320, 200]);
    expect(getLiveDoc()).toBe(before);
  });

  it('the renderer reports it cannot draw: VIEWPORT_CAPTURE_FAILED with its message', async () => {
    fakeRenderer((event) => answerFrame(event.id, { code: 'VIEWPORT_CAPTURE_FAILED', message: 'the 3D viewport is not shown' }));
    const result = await applyCommandAsync('capture_viewport', {});
    expect(result.error?.code).toBe('VIEWPORT_CAPTURE_FAILED');
    expect(result.summary).toContain('not shown');
  });

  it('a renderer that never answers: VIEWPORT_TIMEOUT', async () => {
    process.env['LLULL_VIEWPORT_TIMEOUT_MS'] = '40';
    fakeRenderer(() => undefined);
    const result = await applyCommandAsync('capture_viewport', {});
    expect(result.error?.code).toBe('VIEWPORT_TIMEOUT');
  });

  it('a renderer that disconnects while a frame is asked: VIEWPORT_UNAVAILABLE', async () => {
    let leave: () => void = () => undefined;
    leave = registerRenderer(() => queueMicrotask(() => leave()));
    const result = await applyCommandAsync('capture_viewport', {});
    expect(result.error?.code).toBe('VIEWPORT_UNAVAILABLE');
  });

  it('cancelling the request stops waiting and commits nothing', async () => {
    fakeRenderer(() => undefined);
    const cancel = new AbortController();
    const pending = applyCommandAsync('capture_viewport', {}, { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 20);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.changed).toBe(false);
  });
});

describe('POST /viewport/frame/:id', () => {
  it('delivers the renderer frame to the waiting command (POST /command round trip)', async () => {
    fakeRenderer((event) => {
      void request(app)
        .post(`/viewport/frame/${event.id}`)
        .send({ png: PNG.toString('base64'), width: 64, height: 64 })
        .then((response) => expect(response.status).toBe(200));
    });
    const response = await request(app)
      .post('/command')
      .send({ name: 'capture_viewport', params: { width: 64, height: 64 } });
    expect(response.status).toBe(200);
    expect(response.body.isError).toBe(false);
    expect(Buffer.from(response.body.data.image, 'base64')).toEqual(PNG);
  });

  it('an unknown id is 404, a malformed body 400', async () => {
    const ok = await request(app)
      .post('/viewport/frame/nobody')
      .send({ png: PNG.toString('base64'), width: 8, height: 8 });
    expect(ok.status).toBe(404);
    const bad = await request(app).post('/viewport/frame/nobody').send({ png: 'x', width: 'wide' });
    expect(bad.status).toBe(400);
  });
});

describe('answerOfBody', () => {
  it('reads a frame, an error and refuses everything else', () => {
    expect(answerOfBody({ png: PNG.toString('base64'), width: 2, height: 3 })).toMatchObject({ frame: { width: 2, height: 3 } });
    expect(answerOfBody({ error: { message: 'm' } })).toEqual({ code: 'VIEWPORT_CAPTURE_FAILED', message: 'm' });
    expect(answerOfBody({ error: { code: 'VIEWPORT_TIMEOUT', message: 'm' } })).toMatchObject({ code: 'VIEWPORT_TIMEOUT' });
    expect(answerOfBody({ error: { code: 'OTHER', message: 'm' } })).toMatchObject({ code: 'VIEWPORT_CAPTURE_FAILED' });
    for (const body of [
      null,
      5,
      {},
      { png: 'AAAA', width: 0, height: 1 },
      { png: 'AAAA', width: 5000, height: 1 },
      { png: '', width: 1, height: 1 },
    ])
      expect(answerOfBody(body)).toBeNull();
  });
});
