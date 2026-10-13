import { describe, it, expect, beforeEach } from 'vitest';
import { frameEntityIds, makeFakeRes } from './sseTestHelpers';
import request from 'supertest';
import { app } from '../src/index';
import { getLiveDoc, _resetLiveDoc, subscribeLive } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

const postBox = (): request.Test =>
  request(app)
    .post('/command')
    .send({ name: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0] } });
const entityCount = (): number => Object.keys(getLiveDoc().entities).length;

describe('POST /command', () => {
  it('a mutation returns summary/affected/history flags, updates the live doc and reaches /live subscribers', async () => {
    const fakeRes = makeFakeRes();
    const unsub = subscribeLive(fakeRes);
    const writesBefore = fakeRes.written.length;
    const res = await postBox();
    expect(res.status).toBe(200);
    expect(typeof res.body.summary).toBe('string');
    expect(res.body.affected).toHaveLength(1);
    expect(res.body.isError).toBe(false);
    expect(res.body.canUndo).toBe(true);
    expect(res.body.canRedo).toBe(false);
    expect(entityCount()).toBe(1);
    expect(fakeRes.written.length).toBeGreaterThan(writesBefore);
    expect(frameEntityIds(fakeRes.written.at(-1) ?? '')).toHaveLength(1);
    unsub();
  });

  it.each([{ params: {} }, { name: 42 }, {}, { name: 'add_box', commandId: 5 }, { name: 'add_box', commandId: '' }])(
    '400 for body %j',
    async (body) => {
      const res = await request(app).post('/command').set('Content-Type', 'application/json').send(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
    },
  );

  it('an unknown command is 200 with isError: true', async () => {
    const res = await request(app).post('/command').send({ name: 'totally_unknown_command' });
    expect(res.status).toBe(200);
    expect(res.body.isError).toBe(true);
  });

  it('a retried commandId is not applied twice and returns the same result', async () => {
    const body = { name: 'add_box', params: { size: [1, 1, 1] }, commandId: 'retry-1' };
    const first = await request(app).post('/command').send(body);
    const retry = await request(app).post('/command').send(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(getLiveDoc().order).toHaveLength(1);
  });
});

describe('POST /undo + POST /redo', () => {
  it('undo reverts, redo re-applies', async () => {
    await postBox();
    const undoRes = await request(app).post('/undo').send();
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.summary).toBe('Undid last change.');
    expect(undoRes.body.canRedo).toBe(true);
    expect(entityCount()).toBe(0);
    const redoRes = await request(app).post('/redo').send();
    expect(redoRes.status).toBe(200);
    expect(redoRes.body.summary).toBe('Redid last change.');
    expect(entityCount()).toBe(1);
  });

  it.each([
    ['/undo', 'Nothing to undo.'],
    ['/redo', 'Nothing to redo.'],
  ])('%s on an empty stack is 200 "%s"', async (route, summary) => {
    const res = await request(app).post(route).send();
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe(summary);
    expect(res.body.isError).toBe(false);
  });
});
