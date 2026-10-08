/**
 * @layer server/tests
 * Two clients write the one shared document at the same time while two other clients follow the
 * `/live` log: every follower sees the same gap-free sequence, replays it to the server's exact
 * state hash, and a retried `commandId` is applied once.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveSnapshot, subscribeLive } from '../src/liveDocument';
import { applyLiveCommand, documentHash, type LiveCommandEvent } from '@mcp/liveSync';
import type { CadDocument } from '@core/model/types';
import { parseSseFrame } from './sseTestHelpers';

interface Follower {
  readonly frames: string[];
  readonly write: (chunk: string) => boolean;
  readonly end: () => void;
}

function makeFollower(): Follower {
  const frames: string[] = [];
  return {
    frames,
    write: (chunk) => {
      frames.push(chunk);
      return true;
    },
    end: () => undefined,
  };
}

/** Replay a follower's frames the way the browser does; throws on a gap or hash mismatch. */
function replay(follower: Follower): { document: CadDocument; seq: number; commands: number } {
  const [first, ...rest] = follower.frames.map(parseSseFrame);
  expect(first?.event).toBe('snapshot');
  let document = first!.data['document'] as CadDocument;
  let seq = first!.data['seq'] as number;
  let commands = 0;
  for (const frame of rest) {
    expect(frame.event).toBe('command');
    const event = frame.data as unknown as LiveCommandEvent;
    const applied = applyLiveCommand(document, seq, event);
    if (!applied.ok) throw new Error(`replay failed at seq ${event.seq}: ${applied.reason}`);
    document = applied.document;
    seq = event.seq;
    commands++;
  }
  return { document, seq, commands };
}

const writer = (name: string, index: number, commandId: string): request.Test =>
  request(app)
    .post('/command')
    .send({
      name: 'add_box',
      params: { size: [1, 1, 1], position: [index, name === 'a' ? 0 : 5, 0] },
      commandId,
    });

describe('two concurrent writers', () => {
  beforeEach(() => {
    _resetLiveDoc();
    _resetHistory();
  });

  it('serialize into one gap-free log that every follower replays to the server hash', async () => {
    const [one, two] = [makeFollower(), makeFollower()];
    subscribeLive(one as never);
    subscribeLive(two as never);
    const startSeq = getLiveSnapshot().seq;

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => writer(i % 2 === 0 ? 'a' : 'b', i, `w-${i}`)),
    );
    expect(responses.every((response) => response.status === 200 && !response.body.isError)).toBe(
      true,
    );
    const ids = responses.flatMap((response) => response.body.affected as string[]);
    expect(new Set(ids).size).toBe(20);

    const server = getLiveSnapshot();
    expect(server.seq).toBe(startSeq + 20);
    for (const follower of [one, two]) {
      const replayed = replay(follower);
      expect(replayed.commands).toBe(20);
      expect(replayed.seq).toBe(server.seq);
      expect(documentHash(replayed.document)).toBe(server.stateHash);
    }
    expect(one.frames).toEqual(two.frames);
  });

  it('applies a retried commandId once even when both writers race to send it', async () => {
    const follower = makeFollower();
    subscribeLive(follower as never);
    const startSeq = getLiveSnapshot().seq;

    const racing = await Promise.all([
      writer('a', 0, 'same-id'),
      writer('a', 0, 'same-id'),
      writer('a', 0, 'same-id'),
    ]);
    expect(racing.map((response) => response.body.affected)).toEqual([
      racing[0]?.body.affected,
      racing[0]?.body.affected,
      racing[0]?.body.affected,
    ]);
    expect(getLiveSnapshot().seq).toBe(startSeq + 1);
    expect(Object.keys(getLiveSnapshot().document.entities)).toHaveLength(1);
    expect(replay(follower).commands).toBe(1);
  });

  it('rejects reusing a commandId for a different command without touching the document', async () => {
    await writer('a', 0, 'taken');
    const before = getLiveSnapshot();
    const clash = await request(app)
      .post('/command')
      .send({ name: 'add_sphere', params: { radius: 2 }, commandId: 'taken' });
    expect(clash.body.isError).toBe(true);
    expect(clash.body.summary).toContain('already used');
    expect(getLiveSnapshot().seq).toBe(before.seq);
    expect(getLiveSnapshot().stateHash).toBe(before.stateHash);
  });

  it('interleaved undo from one client is a snapshot every follower can resync from', async () => {
    const follower = makeFollower();
    subscribeLive(follower as never);
    await writer('a', 0, 'u-1');
    await writer('b', 1, 'u-2');
    await request(app).post('/undo').send({});
    const frames = follower.frames.map(parseSseFrame);
    expect(frames.map((frame) => frame.event)).toEqual([
      'snapshot',
      'command',
      'command',
      'snapshot',
    ]);
    const last = frames.at(-1)!;
    expect(last.data['seq']).toBe(getLiveSnapshot().seq);
    expect(last.data['stateHash']).toBe(getLiveSnapshot().stateHash);
    expect(Object.keys((last.data['document'] as CadDocument).entities)).toHaveLength(1);
  });
});
