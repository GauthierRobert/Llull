/**
 * Integration tests for the Zustand CAD store — server-authoritative model.
 *
 * The store's `dispatch` now POSTs to /command on the server; the document
 * update arrives via the /live SSE stream (`hydrateLiveDocument`). These tests
 * verify:
 *   - dispatch() POSTs to the correct endpoint with the right payload
 *   - the store updates lastSummary / canUndo / canRedo from the server response
 *   - lastMeasure is set when the response carries data, preserved otherwise
 *   - hydrateLiveDocument(liveSnapshot()) is the mechanism that actually updates document
 *   - selection helpers remain synchronous local operations
 *   - setDocument() replaces the document and resets canUndo/canRedo
 *
 * fetch is mocked via vi.stubGlobal — no real network calls are made.
 */

import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '@ui/store';
import { serializeDocument } from '@core/commands/persistence';
import {
  localDispatch,
  liveSnapshot,
  TEST_EPOCH,
  flushPromises,
  getState,
} from '../helpers/storeTestHelpers';
import type { ServerCommandResponse } from '@ui/store/serverCommands';
import { mockFetch } from '../helpers/integrationFetch';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a command locally and return the first affected id. */
function dispatchId(name: string, params: unknown): string {
  return localDispatch(name, params).affected[0]!;
}

function resetStore(): void {
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({
    localEditCounter: 0,
    syncState: 'idle',
    sseEverConnected: false,
    document: createEmptyDocument(),
    lastSummary: null,
    lastMeasure: null,
    canUndo: false,
    canRedo: false,
    renderOrigin: [0, 0, 0],
    liveStatus: 'connecting',
    hasUnsyncedLocalEdits: false,
    localUndoStack: [],
    localRedoStack: [],
    liveEpoch: null,
    liveSeq: -1,
  });
}

/** Go online against a simulated server: hydrate an empty snapshot and wait for the outbox replay. */
async function reconnectTo(server: ReturnType<typeof simulatedServer>): Promise<void> {
  vi.stubGlobal('fetch', server.fetch);
  useStore.setState({ liveStatus: 'connected' });
  getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
  await vi.waitFor(() => expect(getState().syncState).toBe('idle'));
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

  it('dispatch sets liveStatus to disconnected on network failure and falls back locally', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    expect(getState().liveStatus).toBe('disconnected');
    expect(getState().document.order).toHaveLength(1);
    expect(getState().lastSummary).toContain('ran locally');
  });

  it('dispatch keeps liveStatus on HTTP 429 and surfaces the error in lastSummary', async () => {
    useStore.setState({ liveStatus: 'connected' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) }),
    );

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    expect(getState().liveStatus).toBe('connected');
    expect(getState().lastSummary).toContain('429');
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
    getState().hydrateLiveDocument(liveSnapshot(getState().document));

    expect(getState().document.selection).toContain(id);
  });

  it('hydrateLiveDocument drops selection for ids that no longer exist', () => {
    getState().select(['stale-id-123']);

    const freshDoc = createEmptyDocument();
    getState().hydrateLiveDocument(liveSnapshot(freshDoc));

    expect(getState().document.selection).toHaveLength(0);
  });

  // ── select ────────────────────────────────────────────────────────────────

  it('select sets document.selection to the provided ids', () => {
    const id = dispatchId('add_box', { size: [1, 1, 1] });

    getState().select([id]);
    expect(getState().document.selection).toEqual([id]);
  });

  it('select replaces the entire selection (not additive)', () => {
    const id1 = dispatchId('add_box', { size: [1, 1, 1] });
    const id2 = dispatchId('add_box', { size: [2, 2, 2] });

    getState().select([id1]);
    getState().select([id2]);

    expect(getState().document.selection).toEqual([id2]);
  });

  it('select is immutable — previous document is not mutated', () => {
    const id = dispatchId('add_box', { size: [1, 1, 1] });
    const docBefore = getState().document;

    getState().select([id]);

    expect(getState().document).not.toBe(docBefore);
    expect(docBefore.selection).toEqual([]);
  });

  // ── toggleSelection ───────────────────────────────────────────────────────

  it('toggleSelection adds an id that is not currently selected', () => {
    const id = dispatchId('add_box', { size: [1, 1, 1] });

    getState().toggleSelection(id);
    expect(getState().document.selection).toContain(id);
  });

  it('toggleSelection removes an id that is already selected', () => {
    const id = dispatchId('add_box', { size: [1, 1, 1] });

    getState().select([id]);
    getState().toggleSelection(id);
    expect(getState().document.selection).not.toContain(id);
  });

  it('toggleSelection preserves other selected ids', () => {
    const id1 = dispatchId('add_box', { size: [1, 1, 1] });
    const id2 = dispatchId('add_box', { size: [2, 2, 2] });

    getState().select([id1, id2]);
    getState().toggleSelection(id1);

    expect(getState().document.selection).toEqual([id2]);
  });

  // ── clearSelection ────────────────────────────────────────────────────────

  it('clearSelection empties document.selection', () => {
    const id = dispatchId('add_box', { size: [1, 1, 1] });

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

// ---------------------------------------------------------------------------
// Offline fallback + reconnect reconciliation
// ---------------------------------------------------------------------------

describe('CadStore — offline fallback', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offline dispatch runs execute locally without any fetch', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    useStore.setState({ liveStatus: 'disconnected' });

    getState().dispatch('add_box', { size: [1, 1, 1] });

    expect(spy).not.toHaveBeenCalled();
    expect(getState().document.order).toHaveLength(1);
    expect(getState().lastSummary).toContain('ran locally');
    expect(getState().hasUnsyncedLocalEdits).toBe(true);
    expect(getState().canUndo).toBe(true);
  });

  it('offline no-op command pushes no history', () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('delete_entity', { id: 'missing' });
    expect(getState().localUndoStack).toHaveLength(0);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
  });

  it('offline undo and redo walk the local snapshot stack', () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_box', { size: [2, 2, 2] });
    expect(getState().document.order).toHaveLength(2);

    getState().undo();
    expect(getState().document.order).toHaveLength(1);
    expect(getState().canRedo).toBe(true);

    getState().undo();
    expect(getState().document.order).toHaveLength(0);
    expect(getState().canUndo).toBe(false);

    getState().redo();
    expect(getState().document.order).toHaveLength(1);
    getState().redo();
    expect(getState().document.order).toHaveLength(2);
    expect(getState().canRedo).toBe(false);
  });

  it('bounds the local undo stack', () => {
    useStore.setState({ liveStatus: 'disconnected' });
    for (let i = 0; i < 105; i++) getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(getState().localUndoStack).toHaveLength(100);
  });

  it('first dispatch while connecting falls back locally on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')));
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(getState().document.order).toHaveLength(1);
    expect(getState().liveStatus).toBe('disconnected');
  });

  it('network failure on undo while connecting falls back to local history', async () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    useStore.setState({ liveStatus: 'connected' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')));
    getState().undo();
    await flushPromises();
    expect(getState().document.order).toHaveLength(0);
  });

  it('HTTP 4xx does NOT fall back locally', async () => {
    useStore.setState({ liveStatus: 'connected' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({}) }),
    );
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(getState().document.order).toHaveLength(0);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().liveStatus).toBe('connected');
  });

  it('reconnect with unsynced edits replays the offline outbox, then adopts the server snapshot', async () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_sphere', { radius: 2 });
    expect(getState().localOutbox.map((c) => c.name)).toEqual(['add_box', 'add_sphere']);
    const server = simulatedServer();
    await reconnectTo(server);

    expect(server.commands()).toEqual(['add_box', 'add_sphere']);
    expect(getState().document.order).toEqual(server.doc().order);
    expect(getState().liveSeq).toBe(2);
    expect(getState().localOutbox).toEqual([]);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
  });

  it('never replays a local-only restore (and its coalesced framing) to the server', async () => {
    useStore.setState({ liveStatus: 'disconnected' });
    const restored = serializeDocument(
      execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document,
    );
    getState().dispatch('load_document', { json: restored }, { localOnly: true });
    getState().dispatch('fit_view', { direction: 'iso' }, { coalesce: true });
    getState().dispatch('add_sphere', { radius: 2 });
    expect(getState().localOutbox.map((c) => [c.name, c.localOnly === true])).toEqual([
      ['load_document', true],
      ['fit_view', true],
      ['add_sphere', false],
    ]);
    const server = simulatedServer();
    await reconnectTo(server);

    expect(server.commands()).toEqual(['add_sphere']);
    expect(getState().localOutbox).toEqual([]);
  });

  it('an offline undo drops its command from the outbox; redo re-queues it', () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_sphere', { radius: 2 });
    getState().undo();
    expect(getState().localOutbox.map((c) => c.name)).toEqual(['add_box']);
    getState().redo();
    expect(getState().localOutbox.map((c) => c.name)).toEqual(['add_box', 'add_sphere']);
  });

  it('failed push keeps the local doc and the unsynced flag', async () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')));

    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
    await flushPromises();

    expect(getState().document.order).toHaveLength(1);
    expect(getState().hasUnsyncedLocalEdits).toBe(true);
  });

  it('reconnect without local edits just hydrates and clears local stacks', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    useStore.setState({ localUndoStack: [createEmptyDocument()] });
    const result = localDispatch('add_box', { size: [1, 1, 1] });

    expect(spy).not.toHaveBeenCalled();
    expect(getState().document.order).toEqual(result.affected);
    expect(getState().localUndoStack).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sync races (select during push, failed push retry, patches, SSE-open network errors)
// ---------------------------------------------------------------------------

function httpFail(status: number): { ok: false; status: number; json: () => Promise<object> } {
  return { ok: false, status, json: () => Promise.resolve({}) };
}

function okResponse(affected?: string[]): {
  ok: true;
  json: () => Promise<ServerCommandResponse>;
} {
  const response = affected === undefined ? DEFAULT_RESPONSE : { ...DEFAULT_RESPONSE, affected };
  return { ok: true, json: () => Promise.resolve(response) };
}

/** Simulated server: POST /command applies via execute; GET /live/snapshot returns state. */
function simulatedServer(failFirst?: number): {
  fetch: ReturnType<typeof vi.fn>;
  commands: () => string[];
  doc: () => CadDocument;
  bodies: () => { name: string; params: unknown; commandId?: string }[];
  /** A concurrent change by another client (e.g. an MCP agent). Returns its affected ids. */
  inject: (name: string, params: unknown) => string[];
} {
  let serverDoc = createEmptyDocument();
  let seq = 0;
  const received: string[] = [];
  const bodies: { name: string; params: unknown; commandId?: string }[] = [];
  let failuresLeft = failFirst === undefined ? 0 : 1;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return Promise.resolve(httpFail(failFirst ?? 500));
    }
    if (url.endsWith('/live/snapshot')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(liveSnapshot(serverDoc, seq)),
      });
    }
    const body = JSON.parse(init?.body as string) as {
      name: string;
      params: unknown;
      commandId?: string;
    };
    received.push(body.name);
    bodies.push(body);
    const result = execute(serverDoc, body.name, body.params);
    if (result.document !== serverDoc) seq += 1;
    serverDoc = result.document;
    return Promise.resolve(okResponse(result.affected));
  });
  return {
    fetch,
    commands: () => received,
    doc: () => serverDoc,
    bodies: () => bodies,
    inject: (name, params) => {
      const result = execute(serverDoc, name, params);
      if (result.document !== serverDoc) seq += 1;
      serverDoc = result.document;
      return result.affected;
    },
  };
}

function makeOfflineEdit(): void {
  useStore.setState({ liveStatus: 'disconnected' });
  getState().dispatch('add_box', { size: [1, 1, 1] });
  useStore.setState({ liveStatus: 'connected' });
}

describe('CadStore — sync race fixes', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    getState().setDocument(createEmptyDocument());
  });

  it('select during push does not leave the unsynced flag set', async () => {
    makeOfflineEdit();
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);

    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
    const id = getState().document.order[0]!;
    getState().select([id]);
    await vi.waitFor(() => expect(getState().syncState).toBe('idle'));

    expect(server.commands()).toEqual(['add_box']);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().syncState).toBe('idle');
  });

  it('failed push (HTTP 429) stays in local mode, then retry succeeds with backoff', async () => {
    vi.useFakeTimers();
    makeOfflineEdit();
    const server = simulatedServer(429);
    vi.stubGlobal('fetch', server.fetch);

    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState().syncState).toBe('failed');
    expect(getState().hasUnsyncedLocalEdits).toBe(true);
    expect(getState().document.order).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(server.commands()).toEqual(['add_box']);
    expect(getState().syncState).toBe('idle');
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().document.order).toHaveLength(1);
  });

  it('a live command arriving while the outbox flushes is superseded by the post-flush snapshot', async () => {
    makeOfflineEdit();
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
    expect(getState().syncState).toBe('syncing');

    expect(
      getState().applyLiveCommand({
        epoch: TEST_EPOCH,
        seq: 99,
        name: 'add_box',
        params: {},
        stateHash: 'x',
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(getState().syncState).toBe('idle'));
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().document.order).toEqual(server.doc().order);
  });

  it('POST network failure with SSE open neither goes offline nor runs locally', async () => {
    useStore.getState().setLiveStatus('connected');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('flaky')));

    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();

    expect(getState().liveStatus).toBe('connected');
    expect(getState().document.order).toHaveLength(0);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().lastSummary).toContain('not applied');
  });

  it('online dispatch during pending sync runs locally and is included in the same flush', async () => {
    makeOfflineEdit();
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);

    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
    getState().dispatch('add_box', { size: [3, 3, 3] });
    expect(getState().document.order).toHaveLength(2);

    await vi.waitFor(() => expect(getState().syncState).toBe('idle'));
    expect(server.commands()).toEqual(['add_box', 'add_box']);
    expect(getState().document.order).toEqual(server.doc().order);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().syncState).toBe('idle');
  });

  it('setDocument resets the unsynced counter and flags', () => {
    makeOfflineEdit();
    getState().setDocument(createEmptyDocument());
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().localEditCounter).toBe(0);
    expect(getState().syncState).toBe('idle');
  });
});

describe('CadStore — live command log', () => {
  beforeEach(() => {
    resetStore();
  });

  it('applies the next broadcast command and keeps the local selection', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 3));
    const after = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const ok = getState().applyLiveCommand({
      epoch: TEST_EPOCH,
      seq: 4,
      name: 'add_box',
      params: { size: [1, 1, 1] },
      stateHash: liveSnapshot(after).stateHash,
    });
    expect(ok).toBe(true);
    expect(getState().liveSeq).toBe(4);
    getState().select([getState().document.order[0]!]);
    expect(getState().liveBase.selection).toEqual([]);
    expect(getState().document.selection).toHaveLength(1);
  });

  it('refuses a gap or a mismatching hash so the caller resyncs', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 3));
    expect(
      getState().applyLiveCommand({
        epoch: TEST_EPOCH,
        seq: 9,
        name: 'add_box',
        params: {},
        stateHash: '',
      }),
    ).toBe(false);
    expect(
      getState().applyLiveCommand({
        epoch: TEST_EPOCH,
        seq: 4,
        name: 'add_box',
        params: { size: [1, 1, 1] },
        stateHash: 'wrong',
      }),
    ).toBe(false);
    expect(getState().liveSeq).toBe(3);
  });
});

describe('CadStore — outbox flush correctness', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    getState().setDocument(createEmptyDocument());
  });

  it('outbox entries get unique client commandIds that are sent to the server', async () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_sphere', { radius: 2 });
    const ids = getState().localOutbox.map((entry) => entry.commandId);
    expect(new Set(ids).size).toBe(2);

    const server = simulatedServer();
    await reconnectTo(server);

    expect(server.bodies().map((body) => body.commandId)).toEqual(ids);
  });

  it('live dispatch also carries a commandId', async () => {
    useStore.setState({ liveStatus: 'connected' });
    const spy = mockFetch(DEFAULT_RESPONSE);
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      commandId?: string;
    };
    expect(typeof body.commandId).toBe('string');
    expect(body.commandId?.length).toBeGreaterThan(0);
  });

  it('undo/redo during a flush are refused and never touch the outbox', async () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_sphere', { radius: 2 });
    const queued = getState().localOutbox.map((entry) => entry.commandId);
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);
    useStore.setState({ liveStatus: 'connected' });
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
    expect(getState().syncState).toBe('syncing');

    getState().undo();
    getState().redo();
    expect(getState().lastSummary).toContain('Sync in progress');
    expect(getState().localOutbox.map((entry) => entry.commandId)).toEqual(queued);

    await vi.waitFor(() => expect(getState().syncState).toBe('idle'));
    expect(server.commands()).toEqual(['add_box', 'add_sphere']);
    expect(getState().document.order).toEqual(server.doc().order);
  });

  it('a dispatch during the flush is appended and the ack removes the right entry', async () => {
    makeOfflineEdit();
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
    getState().dispatch('add_sphere', { radius: 2 });
    await vi.waitFor(() => expect(getState().syncState).toBe('idle'));
    expect(server.commands()).toEqual(['add_box', 'add_sphere']);
    expect(getState().localOutbox).toEqual([]);
  });

  it('flush remaps ids: a later move lands on the client box, not a concurrent agent box', async () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const localBoxId = getState().document.order[0]!;
    getState().dispatch('move_entity', { id: localBoxId, delta: [5, 0, 0] });

    const server = simulatedServer();
    const agentBoxId = server.inject('add_box', { size: [2, 2, 2] })[0]!;
    expect(agentBoxId).toBe(localBoxId); // step-scoped ids collide across branches
    vi.stubGlobal('fetch', server.fetch);
    useStore.setState({ liveStatus: 'connected' });
    getState().hydrateLiveDocument(liveSnapshot(server.doc()));
    await vi.waitFor(() => expect(getState().syncState).toBe('idle'));

    const serverDoc = server.doc();
    expect(serverDoc.order).toHaveLength(2);
    const clientBoxId = serverDoc.order.find((id) => id !== agentBoxId)!;
    expect(serverDoc.entities[agentBoxId]?.position).toEqual([0, 0, 0]);
    expect(serverDoc.entities[clientBoxId]?.position).toEqual([5, 0, 0]);
    expect(getState().document.order).toEqual(serverDoc.order);
  });

  it('the id map survives a failed attempt (retry still remaps)', async () => {
    vi.useFakeTimers();
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const localBoxId = getState().document.order[0]!;
    getState().dispatch('move_entity', { id: localBoxId, delta: [5, 0, 0] });
    const server = simulatedServer();
    const agentBoxId = server.inject('add_box', { size: [2, 2, 2] })[0]!;
    const realFetch = server.fetch;
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (!url.endsWith('/live/snapshot')) {
          posts += 1;
          if (posts === 2) return Promise.reject(new Error('flaky')); // the move, first try
        }
        return realFetch(url, init);
      }),
    );
    useStore.setState({ liveStatus: 'connected' });
    getState().hydrateLiveDocument(liveSnapshot(server.doc()));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState().syncState).toBe('failed');
    await vi.advanceTimersByTimeAsync(1000);

    expect(getState().syncState).toBe('idle');
    const serverDoc = server.doc();
    const clientBoxId = serverDoc.order.find((id) => id !== agentBoxId)!;
    expect(serverDoc.entities[agentBoxId]?.position).toEqual([0, 0, 0]);
    expect(serverDoc.entities[clientBoxId]?.position).toEqual([5, 0, 0]);
  });

  it('offline add_box, undo, add_box does not re-mint the undone id', () => {
    useStore.setState({ liveStatus: 'disconnected' });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const undoneId = getState().document.order[0]!;
    getState().undo();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(getState().document.order).toHaveLength(1);
    expect(getState().document.order[0]).not.toBe(undoneId);
  });
});

describe('CadStore — live epoch ordering', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ liveEpoch: null, liveSeq: -1 });
  });

  it('ignores a stale snapshot from the same epoch with a lower seq', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 5));
    const stale = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    getState().hydrateLiveDocument(liveSnapshot(stale, 3));
    expect(getState().liveSeq).toBe(5);
    expect(getState().document.order).toHaveLength(0);
  });

  it('accepts an equal-seq snapshot and a lower seq from a new epoch (server restart)', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 5));
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 5));
    expect(getState().liveSeq).toBe(5);
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 0, 'restarted'));
    expect(getState().liveSeq).toBe(0);
    expect(getState().liveEpoch).toBe('restarted');
  });

  it('treats an already-applied event as handled and a foreign epoch as a gap', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 5));
    const event = { epoch: TEST_EPOCH, seq: 5, name: 'add_box', params: {}, stateHash: 'x' };
    expect(getState().applyLiveCommand(event)).toBe(true);
    expect(getState().applyLiveCommand({ ...event, seq: 2 })).toBe(true);
    expect(getState().liveSeq).toBe(5);
    expect(getState().applyLiveCommand({ ...event, epoch: 'other', seq: 6 })).toBe(false);
  });
});
