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
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';
import type { ServerCommandResponse } from '@ui/store/serverCommands';

/** Flush all pending microtasks (multiple promise chain hops). */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => resolve());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState(): ReturnType<typeof useStore.getState> {
  return useStore.getState();
}

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
    canUndo: false,
    canRedo: false,
  });
}

function mockFetch(response: ServerCommandResponse): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(response),
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

// ---------------------------------------------------------------------------
// undo()
// ---------------------------------------------------------------------------

describe('undo — server-authoritative', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('undo() POSTs to /undo', async () => {
    const spy = mockFetch({ summary: 'Undone.', affected: [], isError: false, canUndo: false, canRedo: true });

    getState().undo();
    await flushPromises();

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/undo');
    expect(init.method).toBe('POST');
  });

  it('undo() updates lastSummary from the server response', async () => {
    mockFetch({ summary: 'Undone.', affected: [], isError: false, canUndo: false, canRedo: true });

    getState().undo();
    await flushPromises();

    expect(getState().lastSummary).toBe('Undone.');
  });

  it('undo() updates canUndo and canRedo from the server response', async () => {
    mockFetch({ summary: 'Undone.', affected: [], isError: false, canUndo: false, canRedo: true });

    getState().undo();
    await flushPromises();

    expect(getState().canUndo).toBe(false);
    expect(getState().canRedo).toBe(true);
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
    getState().hydrateLiveDocument(emptyDoc);
    expect(getState().document.order).toHaveLength(0);
  });

  it('undo() sets liveStatus to disconnected on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

    getState().undo();
    await flushPromises();

    expect(getState().liveStatus).toBe('disconnected');
    expect(getState().lastSummary).toContain('Network');
  });
});

// ---------------------------------------------------------------------------
// redo()
// ---------------------------------------------------------------------------

describe('redo — server-authoritative', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redo() POSTs to /redo', async () => {
    const spy = mockFetch({ summary: 'Redone.', affected: [], isError: false, canUndo: true, canRedo: false });

    getState().redo();
    await flushPromises();

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/redo');
    expect(init.method).toBe('POST');
  });

  it('redo() updates lastSummary from the server response', async () => {
    mockFetch({ summary: 'Redone.', affected: [], isError: false, canUndo: true, canRedo: false });

    getState().redo();
    await flushPromises();

    expect(getState().lastSummary).toBe('Redone.');
  });

  it('redo() updates canUndo and canRedo from the server response', async () => {
    mockFetch({ summary: 'Redone.', affected: [], isError: false, canUndo: true, canRedo: false });

    getState().redo();
    await flushPromises();

    expect(getState().canUndo).toBe(true);
    expect(getState().canRedo).toBe(false);
  });

  it('redo() sets liveStatus to disconnected on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Timeout')));

    getState().redo();
    await flushPromises();

    expect(getState().liveStatus).toBe('disconnected');
    expect(getState().lastSummary).toContain('Network');
  });
});

// ---------------------------------------------------------------------------
// canUndo / canRedo — UI state driven by server responses
// ---------------------------------------------------------------------------

describe('canUndo / canRedo state', () => {
  beforeEach(() => {
    __resetIdCounter();
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
    mockFetch({ summary: 'Box added.', affected: ['e1'], isError: false, canUndo: true, canRedo: false });

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
