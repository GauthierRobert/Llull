/** `setLiveDoc` hashes the document only when a subscriber will receive it. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const hashed = vi.hoisted(() => ({ count: 0 }));

vi.mock('@protocol/liveSync', async (importOriginal) => {
  const original = await importOriginal<typeof import('@protocol/liveSync')>();
  return {
    ...original,
    documentHash: (...args: Parameters<typeof original.documentHash>): string => {
      hashed.count += 1;
      return original.documentHash(...args);
    },
  };
});

import { subscribeLive, getLiveSnapshot, _resetLiveDoc } from '../src/liveDocument';
import { applyCommand } from '../src/commandBus';
import { makeFakeRes, parseSseFrame } from './sseTestHelpers';
import { applyLiveCommand, documentHash } from '@protocol/liveSync';
import type { CadDocument } from '@core/model/types';

describe('live command hash', () => {
  beforeEach(() => {
    _resetLiveDoc();
    hashed.count = 0;
  });

  it('skips the state hash when no client is subscribed', () => {
    const result = applyCommand('add_box', { size: [1, 1, 1] });
    expect(result.isError).toBe(false);
    expect(hashed.count).toBe(0);
  });

  it('still broadcasts the hashed command event to a subscriber', () => {
    const res = makeFakeRes();
    const unsubscribe = subscribeLive(res as never);
    res.written.length = 0;
    applyCommand('add_box', { size: [1, 1, 1] });
    unsubscribe();
    expect(hashed.count).toBeGreaterThan(0);
    expect(res.written).toHaveLength(1);
    const frame = parseSseFrame(res.written[0] ?? '');
    expect(frame.event).toBe('command');
    expect(frame.data['stateHash']).toBe(getLiveSnapshot().stateHash);
  });

  it('a late subscriber gets a consistent snapshot and can follow the next command', () => {
    applyCommand('add_box', { size: [1, 1, 1] });
    applyCommand('add_box', { size: [2, 2, 2] });
    const res = makeFakeRes();
    const unsubscribe = subscribeLive(res as never);
    const snapshot = parseSseFrame(res.written[0] ?? '');
    expect(snapshot.event).toBe('snapshot');
    const document = snapshot.data['document'] as CadDocument;
    expect(Object.keys(document.entities)).toHaveLength(2);
    expect(snapshot.data['seq']).toBe(getLiveSnapshot().seq);
    expect(snapshot.data['stateHash']).toBe(documentHash(document));

    applyCommand('add_box', { size: [3, 3, 3] });
    unsubscribe();
    const event = parseSseFrame(res.written[1] ?? '');
    expect(event.data['seq']).toBe((snapshot.data['seq'] as number) + 1);
    const applied = applyLiveCommand(document, snapshot.data['seq'] as number, {
      epoch: String(event.data['epoch']),
      seq: event.data['seq'] as number,
      name: String(event.data['name']),
      params: event.data['params'],
      stateHash: String(event.data['stateHash']),
    });
    expect(applied.ok).toBe(true);
  });
});
