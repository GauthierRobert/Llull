/**
 * Dispatch while the /live stream is still "connecting" (never connected): the POST gets a short
 * grace period, then the command runs locally under the same commandId instead of leaving the
 * document unchanged until the POST finally fails (a refused connection can take seconds).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { CONNECT_GRACE_MS } from '@ui/store/onlineMode';

function resetStore(liveStatus: 'connecting' | 'connected'): void {
  useStore.setState({
    document: createEmptyDocument(),
    liveStatus,
    sseEverConnected: false,
    hasUnsyncedLocalEdits: false,
    syncState: 'idle',
    localUndoStack: [],
    localRedoStack: [],
    localOutbox: [],
    localRedoOutbox: [],
    lastSummary: null,
  });
}

describe('dispatch while connecting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore('connecting');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs locally after the grace period even if the POST never settles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(useStore.getState().document.order).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS);

    expect(useStore.getState().document.order).toHaveLength(1);
    expect(useStore.getState().localOutbox).toHaveLength(1);
  });

  it('does not apply the command twice when the POST fails after the local run', async () => {
    let rejectFetch: (reason: Error) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((_resolve, reject) => (rejectFetch = reject))),
    );
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS);
    rejectFetch(new Error('refused'));
    await vi.advanceTimersByTimeAsync(10);

    expect(useStore.getState().document.order).toHaveLength(1);
    expect(useStore.getState().localOutbox).toHaveLength(1);
  });

  it('does not run locally when the POST answers within the grace period', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            summary: 'ok',
            affected: [],
            isError: false,
            canUndo: false,
            canRedo: false,
          }),
      }),
    );
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS * 2);

    expect(useStore.getState().localOutbox).toHaveLength(0);
    expect(useStore.getState().document.order).toHaveLength(0);
  });

  it('keeps dispatch order when a later POST fails fast while an earlier one hangs', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(() => Promise.reject(new Error('refused')));
    vi.stubGlobal('fetch', fetchMock);
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    useStore.getState().dispatch('add_sphere', { radius: 1 });
    await vi.advanceTimersByTimeAsync(10);

    const { document, localOutbox } = useStore.getState();
    expect(localOutbox.map((entry) => entry.name)).toEqual(['add_box', 'add_sphere']);
    expect(document.order.map((id) => document.entities[id]?.kind)).toEqual(['box', 'sphere']);

    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS);
    expect(useStore.getState().document.order).toHaveLength(2);
  });

  it('never starts the grace timer once connected (a slow POST is waited for)', async () => {
    resetStore('connected');
    useStore.setState({ sseEverConnected: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS * 5);
    expect(useStore.getState().document.order).toHaveLength(0);
  });
});
