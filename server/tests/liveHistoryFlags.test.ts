/** Live events carry the backend's undo / redo availability, so every window's Toolbar follows commands it did not send. */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetHistory, applyCommand, undo } from '../src/commandBus';
import { _resetLiveDoc, getLiveSnapshot, subscribeLive } from '../src/liveDocument';
import { parseSseFrame } from './sseTestHelpers';

const BOX = { size: [1, 1, 1] };

function follow(): string[] {
  const frames: string[] = [];
  subscribeLive({ write: (chunk: string) => (frames.push(chunk), true), end: () => undefined } as never);
  return frames;
}

describe('live history flags', () => {
  beforeEach(() => {
    _resetLiveDoc();
    _resetHistory();
  });

  it('a command event and a snapshot carry canUndo / canRedo; a new command after an undo clears redo', async () => {
    const frames = follow();
    expect(parseSseFrame(frames[0]!).data).toMatchObject({ canUndo: false, canRedo: false });

    applyCommand('add_box', BOX, undefined, 'cli');
    undo();
    expect(getLiveSnapshot()).toMatchObject({ canUndo: false, canRedo: true });
    expect((await request(app).get('/live/snapshot')).body).toMatchObject({ canUndo: false, canRedo: true });

    applyCommand('add_box', BOX, undefined, 'cli');
    const events = frames.map(parseSseFrame).filter((frame) => frame.event === 'command');
    expect(events.at(-1)?.data).toMatchObject({ source: 'cli', canUndo: true, canRedo: false });
    expect(events[0]?.data).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('POST /command with coalesce folds the change into the previous undo step: one undo takes back both', async () => {
    const first = await request(app).post('/command').send({ name: 'add_box', params: BOX });
    expect(first.body.changed).toBe(true);
    await request(app).post('/command').send({ name: 'add_box', params: BOX, coalesce: true });
    expect(Object.keys(getLiveSnapshot().document.entities)).toHaveLength(2);
    const undone = await request(app).post('/undo').send({});
    expect(undone.body).toMatchObject({ canUndo: false, canRedo: true });
    expect(Object.keys(getLiveSnapshot().document.entities)).toHaveLength(0);
  });

  it('without coalesce each command is its own undo step', async () => {
    await request(app).post('/command').send({ name: 'add_box', params: BOX });
    await request(app).post('/command').send({ name: 'add_box', params: BOX });
    await request(app).post('/undo').send({});
    expect(Object.keys(getLiveSnapshot().document.entities)).toHaveLength(1);
  });
});
