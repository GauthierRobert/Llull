/**
 * Integration tests for the Zustand CAD store — server-authoritative model.
 *
 * The store's `dispatch` now POSTs to /command on the server; the document
 * update arrives via the /live SSE stream (`hydrateLiveDocument`). These tests
 * verify:
 *   - dispatch() POSTs to the correct endpoint with the right payload
 *   - the store updates lastSummary / canUndo / canRedo from the server response
 *   - lastMeasure is set when the response carries data, preserved otherwise
 *   - hydrateLiveDocument() is the mechanism that actually updates document
 *   - selection helpers remain synchronous local operations
 *   - setDocument() replaces the document and resets canUndo/canRedo
 *
 * fetch is mocked via vi.stubGlobal — no real network calls are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence';
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
    lastMeasure: null,
    canUndo: false,
    canRedo: false,
    renderOrigin: [0, 0, 0],
    liveStatus: 'connecting',
  });
}

/**
 * Build a mock fetch that resolves with the given ServerCommandResponse.
 * Also returns a spy so callers can assert it was called.
 */
function mockFetch(response: ServerCommandResponse): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(response),
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const DEFAULT_RESPONSE: ServerCommandResponse = {
  summary: 'Box added.',
  affected: ['entity-1'],
  isError: false,
  canUndo: true,
  canRedo: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CadStore — networked dispatch', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatch POSTs to /command with the correct name and params', async () => {
    const spy = mockFetch(DEFAULT_RESPONSE);

    getState().dispatch('add_box', { size: [2, 2, 2] });
    await flushPromises();

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/command');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { name: string; params: unknown };
    expect(body.name).toBe('add_box');
    expect(body.params).toEqual({ size: [2, 2, 2] });
  });

  it('dispatch updates lastSummary from the server response', async () => {
    mockFetch({ ...DEFAULT_RESPONSE, summary: 'Box created at origin.' });

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    expect(getState().lastSummary).toBe('Box created at origin.');
  });

  it('dispatch updates canUndo and canRedo from the server response', async () => {
    mockFetch({ ...DEFAULT_RESPONSE, canUndo: true, canRedo: false });

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    expect(getState().canUndo).toBe(true);
    expect(getState().canRedo).toBe(false);
  });

  it('dispatch sets lastMeasure when the response includes data', async () => {
    mockFetch({
      summary: 'Distance: 5mm',
      affected: [],
      isError: false,
      data: { distance: 5, unit: 'mm' },
      canUndo: false,
      canRedo: false,
    });

    getState().dispatch('measure_distance', { point1: [0, 0, 0], point2: [3, 4, 0] });
    await flushPromises();

    const m = getState().lastMeasure;
    expect(m).not.toBeNull();
    expect(m?.command).toBe('measure_distance');
    expect((m?.data as { distance: number }).distance).toBe(5);
  });

  it('dispatch does NOT overwrite lastMeasure when the response has no data', async () => {
    // Pre-set a measure result
    useStore.setState({ lastMeasure: { command: 'measure_distance', data: { distance: 5 } } });
    mockFetch({ ...DEFAULT_RESPONSE, data: undefined });

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    // lastMeasure must be preserved — a mutating command doesn't clear it here
    // (the document arriving via /live is what matters; the response has no data)
    expect(getState().lastMeasure?.command).toBe('measure_distance');
  });

  it('dispatch sets liveStatus to disconnected on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    expect(getState().liveStatus).toBe('disconnected');
    expect(getState().lastSummary).toContain('Network');
  });

  it('dispatch does NOT update document — only hydrateLiveDocument does', async () => {
    mockFetch(DEFAULT_RESPONSE);

    const docBefore = getState().document;
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    // document must be the same reference — only /live SSE updates it
    expect(getState().document).toBe(docBefore);
  });

  it('hydrateLiveDocument updates the document (simulates /live SSE push)', () => {
    const result = localDispatch('add_box', { size: [2, 2, 2] });
    expect(getState().document.order).toHaveLength(1);

    const id = result.affected[0]!;
    expect(getState().document.entities[id]?.kind).toBe('box');
  });

  it('successive localDispatch (SSE simulation) accumulates entities', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('add_box', { size: [2, 2, 2] });

    expect(getState().document.order).toHaveLength(2);
  });

  // ── setDocument ───────────────────────────────────────────────────────────

  it('setDocument replaces the document, clears lastSummary, canUndo, canRedo', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    useStore.setState({ lastSummary: 'something', canUndo: true, canRedo: true });

    const fresh = createEmptyDocument();
    getState().setDocument(fresh);

    expect(getState().document).toBe(fresh);
    expect(getState().document.order).toHaveLength(0);
    expect(getState().lastSummary).toBeNull();
    expect(getState().canUndo).toBe(false);
    expect(getState().canRedo).toBe(false);
  });

  // ── hydrateLiveDocument — selection preservation ──────────────────────────

  it('hydrateLiveDocument preserves selection for ids that still exist', () => {
    const result = localDispatch('add_box', { size: [1, 1, 1] });
    const id = result.affected[0]!;

    getState().select([id]);

    // Simulate a /live push with the same doc
    getState().hydrateLiveDocument(getState().document);

    expect(getState().document.selection).toContain(id);
  });

  it('hydrateLiveDocument drops selection for ids that no longer exist', () => {
    getState().select(['stale-id-123']);

    const freshDoc = createEmptyDocument();
    getState().hydrateLiveDocument(freshDoc);

    expect(getState().document.selection).toHaveLength(0);
  });

  // ── select ────────────────────────────────────────────────────────────────

  it('select sets document.selection to the provided ids', () => {
    const r = localDispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().select([id]);
    expect(getState().document.selection).toEqual([id]);
  });

  it('select replaces the entire selection (not additive)', () => {
    const r1 = localDispatch('add_box', { size: [1, 1, 1] });
    const r2 = localDispatch('add_box', { size: [2, 2, 2] });
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;

    getState().select([id1]);
    getState().select([id2]);

    expect(getState().document.selection).toEqual([id2]);
  });

  it('select is immutable — previous document is not mutated', () => {
    const r = localDispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;
    const docBefore = getState().document;

    getState().select([id]);

    expect(getState().document).not.toBe(docBefore);
    expect(docBefore.selection).toEqual([]);
  });

  // ── toggleSelection ───────────────────────────────────────────────────────

  it('toggleSelection adds an id that is not currently selected', () => {
    const r = localDispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().toggleSelection(id);
    expect(getState().document.selection).toContain(id);
  });

  it('toggleSelection removes an id that is already selected', () => {
    const r = localDispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().select([id]);
    getState().toggleSelection(id);
    expect(getState().document.selection).not.toContain(id);
  });

  it('toggleSelection preserves other selected ids', () => {
    const r1 = localDispatch('add_box', { size: [1, 1, 1] });
    const r2 = localDispatch('add_box', { size: [2, 2, 2] });
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;

    getState().select([id1, id2]);
    getState().toggleSelection(id1);

    expect(getState().document.selection).toEqual([id2]);
  });

  // ── clearSelection ────────────────────────────────────────────────────────

  it('clearSelection empties document.selection', () => {
    const r = localDispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().select([id]);
    expect(getState().document.selection).toHaveLength(1);

    getState().clearSelection();
    expect(getState().document.selection).toHaveLength(0);
  });

  it('clearSelection is a no-op when nothing is selected', () => {
    const docBefore = getState().document;
    getState().clearSelection();
    expect(getState().document.selection).toEqual([]);
    expect(getState().document.entities).toEqual(docBefore.entities);
  });
});

// ---------------------------------------------------------------------------
// renderOrigin — floating-origin render state (render-only, NOT in document)
// ---------------------------------------------------------------------------

describe('CadStore — renderOrigin (floating-origin)', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('setRenderOrigin updates renderOrigin', () => {
    getState().setRenderOrigin([1e4, 0, -2e4]);
    expect(getState().renderOrigin).toEqual([1e4, 0, -2e4]);
  });

  it('setRenderOrigin does NOT change the document reference', () => {
    const docBefore = getState().document;
    getState().setRenderOrigin([5e6, 5e6, 5e6]);
    expect(getState().document).toBe(docBefore);
  });

  it('renderOrigin never leaks into the serialized document', () => {
    getState().setRenderOrigin([1234, 5678, 9012]);
    const serialized = serializeDocument(getState().document);
    expect(serialized).not.toContain('renderOrigin');
    expect(serialized).not.toContain('1234');
  });
});
