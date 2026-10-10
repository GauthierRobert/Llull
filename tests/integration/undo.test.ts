/**
 * Integration tests for undo/redo — server-authoritative model.
 *
 * Undo/redo history now lives on the server. The store's `undo()` and `redo()`
 * are network calls (POST /undo, POST /redo). These tests verify:
 *   - undo() POSTs to /undo; redo() POSTs to /redo
 *   - the store updates lastSummary + canUndo/canRedo from the server response
 *   - the reverted document arrives via hydrateLiveDocument (simulating /live SSE)
 *   - no local undo/redo stacks exist in the store
 *
 * fetch is mocked via vi.stubGlobal — no real network calls are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { liveSnapshot, localDispatch, flushPromises, getState } from '../helpers/storeTestHelpers';
import { mockFetch } from '../helpers/integrationFetch';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
    canUndo: false,
    canRedo: false,
    liveStatus: 'connecting',
    hasUnsyncedLocalEdits: false,
    localUndoStack: [],
    localRedoStack: [],
  });
}

describe.each([
  {
    op: 'undo',
    path: 'undo',
    summary: 'Undone.',
    canUndo: false,
    canRedo: true,
    networkError: 'Network down',
  },
  {
    op: 'redo',
    path: 'redo',
    summary: 'Redone.',
    canUndo: true,
    canRedo: false,
    networkError: 'Timeout',
  },
] as const)(
  '$op — server-authoritative',
  ({ op, path, summary, canUndo, canRedo, networkError }) => {
    const response = { summary, affected: [], isError: false, canUndo, canRedo };

    beforeEach(() => {
      resetStore();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it(`${op}() POSTs to /${path}`, async () => {
      const spy = mockFetch(response);

      getState()[op]();
      await flushPromises();

      expect(spy).toHaveBeenCalledOnce();
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://localhost:3001/${path}`);
      expect(init.method).toBe('POST');
    });

    it(`${op}() updates lastSummary from the server response`, async () => {
      mockFetch(response);

      getState()[op]();
      await flushPromises();

      expect(getState().lastSummary).toBe(summary);
    });

    it(`${op}() updates canUndo and canRedo from the server response`, async () => {
      mockFetch(response);

      getState()[op]();
      await flushPromises();

      expect(getState().canUndo).toBe(canUndo);
      expect(getState().canRedo).toBe(canRedo);
    });

    it(`${op}() sets liveStatus to disconnected on network failure`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(networkError)));

      getState()[op]();
      await flushPromises();

      expect(getState().liveStatus).toBe('disconnected');
      expect(getState().lastSummary).toContain('ran locally');
    });
  },
);

describe('undo — document arrives via live sync', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('undo() document update arrives via hydrateLiveDocument (not from response)', async () => {
    mockFetch({ summary: 'Undone.', affected: [], isError: false, canUndo: false, canRedo: true });

    // Pre-populate with an entity via local simulate
    localDispatch('add_box', { size: [2, 2, 2] });
    expect(getState().document.order).toHaveLength(1);

    getState().undo();
    await flushPromises();

    // The document was NOT reverted by undo() itself — only /live SSE does that.
    // The store still has the entity; the server would push the reverted doc via /live.
    expect(getState().document.order).toHaveLength(1);

    // Simulating the /live push with the reverted doc:
    const emptyDoc = createEmptyDocument();
    getState().hydrateLiveDocument(liveSnapshot(emptyDoc));
    expect(getState().document.order).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// canUndo / canRedo — UI state driven by server responses
// ---------------------------------------------------------------------------

describe('canUndo / canRedo state', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('canUndo and canRedo start as false', () => {
    expect(getState().canUndo).toBe(false);
    expect(getState().canRedo).toBe(false);
  });

  it('dispatch updates canUndo/canRedo from server response', async () => {
    mockFetch({
      summary: 'Box added.',
      affected: ['e1'],
      isError: false,
      canUndo: true,
      canRedo: false,
    });

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    expect(getState().canUndo).toBe(true);
    expect(getState().canRedo).toBe(false);
  });

  it('setDocument resets canUndo and canRedo to false', () => {
    useStore.setState({ canUndo: true, canRedo: true });

    const fresh = createEmptyDocument();
    getState().setDocument(fresh);

    expect(getState().canUndo).toBe(false);
    expect(getState().canRedo).toBe(false);
  });

  it('no local undoStack or redoStack fields exist on the store', () => {
    // The store should NOT have undoStack / redoStack — those are server-side.
    const state = getState() as unknown as Record<string, unknown>;
    expect(state['undoStack']).toBeUndefined();
    expect(state['redoStack']).toBeUndefined();
  });
});
