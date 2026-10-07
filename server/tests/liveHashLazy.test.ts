/**
 * @layer server/tests
 * `setLiveDoc` hashes the document (a full serialization) only when a subscriber will receive it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const serialized = vi.hoisted(() => ({ count: 0 }));

vi.mock('@core/commands/persistence', async (importOriginal) => {
  const original = await importOriginal<typeof import('@core/commands/persistence')>();
  return {
    ...original,
    serializeDocument: (...args: Parameters<typeof original.serializeDocument>): string => {
      serialized.count += 1;
      return original.serializeDocument(...args);
    },
  };
});

import { subscribeLive, getLiveSnapshot, _resetLiveDoc } from '../src/liveDocument';
import { applyCommand } from '../src/commandBus';
import { parseSseFrame } from './sseTestHelpers';

function makeFakeRes(): { written: string[]; write(chunk: string): boolean; end(): void } {
  return {
    written: [],
    write(chunk: string): boolean {
      this.written.push(chunk);
      return true;
    },
    end(): void {},
  };
}

describe('live command hash', () => {
  beforeEach(() => {
    _resetLiveDoc();
    serialized.count = 0;
  });

  it('skips the state hash when no client is subscribed', () => {
    const result = applyCommand('add_box', { size: [1, 1, 1] });
    expect(result.isError).toBe(false);
    expect(serialized.count).toBe(0);
  });

  it('still broadcasts the hashed command event to a subscriber', () => {
    const res = makeFakeRes();
    const unsubscribe = subscribeLive(res as never);
    res.written.length = 0;
    applyCommand('add_box', { size: [1, 1, 1] });
    unsubscribe();
    expect(res.written).toHaveLength(1);
    const frame = parseSseFrame(res.written[0] ?? '');
    expect(frame.event).toBe('command');
    expect(frame.data['stateHash']).toBe(getLiveSnapshot().stateHash);
  });
});
