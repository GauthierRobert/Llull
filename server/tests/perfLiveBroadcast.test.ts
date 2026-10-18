/** A broadcast serializes its payload once, however many subscribers receive it. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeLive, setLiveDoc, _resetLiveDoc, closeAllSubscribers } from '../src/liveDocument';
import { applyCommand } from '../src/commandBus';
import { makeFakeRes } from './sseTestHelpers';
import { createEmptyDocument } from '@core/model/types';

beforeEach(() => _resetLiveDoc());
afterEach(() => {
  closeAllSubscribers();
  vi.restoreAllMocks();
});

describe('live broadcast', () => {
  it('stringifies a snapshot once for N subscribers, and every subscriber gets identical bytes', () => {
    const subscribers = Array.from({ length: 5 }, () => makeFakeRes());
    for (const res of subscribers) subscribeLive(res as never);
    for (const res of subscribers) res.written.length = 0;
    const stringify = vi.spyOn(JSON, 'stringify');
    setLiveDoc(createEmptyDocument());
    const documentSerializations = stringify.mock.calls.filter(
      ([value]) => (value as { document?: unknown } | null)?.document !== undefined,
    );
    expect(documentSerializations).toHaveLength(1);
    const [first, ...others] = subscribers.map((res) => res.written.join(''));
    expect(first).toContain('event: snapshot');
    for (const other of others) expect(other).toBe(first);
  });

  it('stringifies a command event once for N subscribers', () => {
    const subscribers = Array.from({ length: 4 }, () => makeFakeRes());
    for (const res of subscribers) subscribeLive(res as never);
    for (const res of subscribers) res.written.length = 0;
    const stringify = vi.spyOn(JSON, 'stringify');
    applyCommand('add_box', { size: [1, 1, 1] });
    const events = stringify.mock.calls.filter(([value]) => (value as { stateHash?: unknown } | null)?.stateHash !== undefined);
    expect(events).toHaveLength(1);
    for (const res of subscribers) expect(res.written.join('')).toContain('event: command');
  });
});
