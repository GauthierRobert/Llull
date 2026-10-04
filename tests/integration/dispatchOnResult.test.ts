/**
 * dispatch(name, params, { onResult }) reports THIS dispatch's outcome exactly once — locally,
 * from the server response, and on a failed POST — and never another command's summary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => resolve());
}

function serverResponse(body: Record<string, unknown>, ok = true): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? 'OK' : 'Bad Request',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('dispatch onResult', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected', localUndoStack: [], localRedoStack: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a local change, then a local no-op', () => {
    const onResult = vi.fn();
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { onResult });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[0]).toMatchObject({ changed: true });
    expect(onResult.mock.calls[0]?.[0].summary).toMatch(/box/i);

    onResult.mockClear();
    useStore.getState().dispatch('add_box', { size: [0, 1, 1] }, { onResult });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[0]).toMatchObject({ changed: false });
  });

  it('reports the server response, not a summary that landed in between', async () => {
    useStore.setState({ liveStatus: 'connected' });
    vi.stubGlobal(
      'fetch',
      serverResponse({
        summary: 'Added box box-9.',
        affected: ['box-9'],
        isError: false,
        canUndo: true,
        canRedo: false,
      }),
    );
    const onResult = vi.fn();
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { onResult });
    useStore.setState({ lastSummary: 'Undid last step.' });
    expect(onResult).not.toHaveBeenCalled();
    await flushPromises();
    expect(onResult).toHaveBeenCalledWith({ summary: 'Added box box-9.', changed: true });
  });

  it('reports a failed POST as unchanged', async () => {
    useStore.setState({ liveStatus: 'connected', sseEverConnected: true });
    vi.stubGlobal('fetch', serverResponse({ error: 'boom' }, false));
    const onResult = vi.fn();
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { onResult });
    await flushPromises();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[0]).toMatchObject({ changed: false });
  });
});
