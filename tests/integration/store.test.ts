import { httpFail, mockFetch } from '../helpers/integrationFetch';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { useStore } from '@ui/store';
import { serializeDocument } from '@core/commands/persistence/serialization';
import {
  localDispatch,
  liveSnapshot,
  TEST_EPOCH,
  expectUndoRedoFlagsAfterDispatch,
  flushPromises,
  getState,
} from '../helpers/storeTestHelpers';
import type { ServerCommandResponse } from '@ui/store/serverCommands';

const dispatchId = (name: string, params: unknown): string => localDispatch(name, params).affected[0]!;
const order = (): string[] => getState().document.order;
const selection = (): readonly string[] => getState().document.selection;
const offline = (): void => useStore.setState({ liveStatus: 'disconnected' });
const online = (): void => useStore.setState({ liveStatus: 'connected' });
const reject = (message = 'refused'): void => void vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(message)));
const httpStatus = (status: number): void => void vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpFail(status)));
const hydrateEmpty = (): void => getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument()));
const idle = (): Promise<void> => vi.waitFor(() => expect(getState().syncState).toBe('idle'));

function resetStore(): void {
  getState().setDocument(createEmptyDocument());
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

/** Reset the store before each test; restore timers, globals and the document after. */
function useCleanStoreHooks(): void {
  beforeEach(resetStore);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    getState().setDocument(createEmptyDocument());
  });
}

const DEFAULT_RESPONSE: ServerCommandResponse = {
  summary: 'Box added.',
  affected: ['entity-1'],
  isError: false,
  canUndo: true,
  canRedo: false,
};

/** Simulated server: POST /command applies via execute; GET /live/snapshot returns state. */
function simulatedServer(failFirst?: number): {
  fetch: Mock<(url: string, init?: RequestInit) => Promise<unknown>>;
  commands: () => string[];
  doc: () => CadDocument;
  bodies: () => { name: string; params: unknown; commandId?: string }[];
  /** A concurrent change by another client (e.g. the CLI with --app). Returns its affected ids. */
  inject: (name: string, params: unknown) => string[];
} {
  let serverDoc = createEmptyDocument();
  let seq = 0;
  const bodies: { name: string; params: unknown; commandId?: string }[] = [];
  let failuresLeft = failFirst === undefined ? 0 : 1;
  const apply = (name: string, params: unknown): string[] => {
    const result = execute(serverDoc, name, params);
    if (result.document !== serverDoc) seq += 1;
    serverDoc = result.document;
    return result.affected;
  };
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return Promise.resolve(httpFail(failFirst ?? 500));
    }
    if (url.endsWith('/live/snapshot')) return Promise.resolve({ ok: true, json: () => Promise.resolve(liveSnapshot(serverDoc, seq)) });
    const body = JSON.parse(init?.body as string) as { name: string; params: unknown; commandId?: string };
    bodies.push(body);
    const affected = apply(body.name, body.params);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...DEFAULT_RESPONSE, affected }) });
  });
  return { fetch, commands: () => bodies.map((b) => b.name), doc: () => serverDoc, bodies: () => bodies, inject: apply };
}

async function reconnectTo(server: ReturnType<typeof simulatedServer>, snapshot = createEmptyDocument()): Promise<void> {
  vi.stubGlobal('fetch', server.fetch);
  online();
  getState().hydrateLiveDocument(liveSnapshot(snapshot));
  await idle();
}

function makeOfflineEdit(): void {
  offline();
  getState().dispatch('add_box', { size: [1, 1, 1] });
  online();
}

/** Offline: a client box moved +5 x; the simulated server meanwhile got an agent box. */
function offlineMoveBesideAgentBox(): { server: ReturnType<typeof simulatedServer>; agentBoxId: string; localBoxId: string } {
  offline();
  getState().dispatch('add_box', { size: [1, 1, 1] });
  const localBoxId = order()[0]!;
  getState().dispatch('move_entities', { ids: [localBoxId], delta: [5, 0, 0] });
  const server = simulatedServer();
  return { server, agentBoxId: server.inject('add_box', { size: [2, 2, 2] })[0]!, localBoxId };
}

/** The agent's box stayed at the origin; the other box carries the client's +5 x move. */
function expectMoveOnClientBox(serverDoc: CadDocument, agentBoxId: string): void {
  const clientBoxId = serverDoc.order.find((id) => id !== agentBoxId)!;
  expect(serverDoc.entities[agentBoxId]?.position).toEqual([0, 0, 0]);
  expect(serverDoc.entities[clientBoxId]?.position).toEqual([5, 0, 0]);
}

describe('CadStore — networked dispatch', () => {
  useCleanStoreHooks();

  it('dispatch POSTs name and params to /command and adopts the response summary / flags, not the document', async () => {
    const spy = mockFetch({ ...DEFAULT_RESPONSE, summary: 'Box created at origin.' });
    const before = getState().document;
    getState().dispatch('add_box', { size: [2, 2, 2] });
    await flushPromises();
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect([url, init.method]).toEqual(['http://localhost:3001/command', 'POST']);
    expect(JSON.parse(init.body as string)).toMatchObject({ name: 'add_box', params: { size: [2, 2, 2] } });
    expect(getState().lastSummary).toBe('Box created at origin.');
    expect(getState().document).toBe(before);
    mockFetch({ ...DEFAULT_RESPONSE, canUndo: true, canRedo: false });
    await expectUndoRedoFlagsAfterDispatch(true, false);
  });

  it('lastMeasure is set from response data and kept when a response has none', async () => {
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
    expect(getState().lastMeasure).toMatchObject({ command: 'measure_distance', data: { distance: 5 } });
    mockFetch({ ...DEFAULT_RESPONSE, data: undefined });
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(getState().lastMeasure?.command).toBe('measure_distance');
  });

  it('a network failure goes offline and runs locally', async () => {
    reject('Network down');
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(getState().liveStatus).toBe('disconnected');
    expect(order()).toHaveLength(1);
    expect(getState().lastSummary).toContain('ran locally');
  });

  it('HTTP 429 keeps the connection and reports the status', async () => {
    online();
    httpStatus(429);
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(getState().liveStatus).toBe('connected');
    expect(getState().lastSummary).toContain('429');
  });

  it('hydrateLiveDocument applies /live pushes and keeps only surviving selection', () => {
    const id = dispatchId('add_box', { size: [2, 2, 2] });
    expect(getState().document.entities[id]?.kind).toBe('box');
    localDispatch('add_box', { size: [1, 1, 1] });
    expect(order()).toHaveLength(2);
    getState().select([id]);
    getState().hydrateLiveDocument(liveSnapshot(getState().document));
    expect(selection()).toContain(id);
    getState().select(['stale-id-123']);
    hydrateEmpty();
    expect(selection()).toHaveLength(0);
  });

  it('setDocument replaces the document and clears summary and undo flags', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    useStore.setState({ lastSummary: 'something', canUndo: true, canRedo: true });
    const fresh = createEmptyDocument();
    getState().setDocument(fresh);
    expect(getState().document).toBe(fresh);
    expect([getState().lastSummary, getState().canUndo, getState().canRedo]).toEqual([null, false, false]);
  });

  it('select replaces immutably; toggleSelection adds/removes; clearSelection empties', () => {
    const id1 = dispatchId('add_box', { size: [1, 1, 1] });
    const id2 = dispatchId('add_box', { size: [2, 2, 2] });
    const before = getState().document;
    getState().select([id1]);
    expect(getState().document).not.toBe(before);
    expect(before.selection).toEqual([]);
    getState().select([id2]);
    expect(selection()).toEqual([id2]);
    getState().toggleSelection(id1);
    expect(selection()).toEqual([id2, id1]);
    getState().toggleSelection(id2);
    expect(selection()).toEqual([id1]);
    getState().toggleSelection(id1);
    expect(selection()).not.toContain(id1);
    getState().select([id1, id2]);
    getState().toggleSelection(id1);
    expect(selection()).toEqual([id2]);
    getState().clearSelection();
    expect(selection()).toHaveLength(0);
    const entities = getState().document.entities;
    getState().clearSelection();
    expect(selection()).toEqual([]);
    expect(getState().document.entities).toEqual(entities);
  });

  it('renderOrigin is render-only: never in the document reference or its serialization', () => {
    const before = getState().document;
    getState().setRenderOrigin([1234, 5678, 9012]);
    expect(getState().renderOrigin).toEqual([1234, 5678, 9012]);
    expect(getState().document).toBe(before);
    const serialized = serializeDocument(getState().document);
    expect(serialized).not.toContain('renderOrigin');
    expect(serialized).not.toContain('1234');
  });
});

describe('CadStore — offline fallback', () => {
  useCleanStoreHooks();

  it('offline dispatch runs locally without fetch; no-ops push no history', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    offline();
    getState().dispatch('delete_entities', { ids: ['missing'] });
    expect(getState().localUndoStack).toHaveLength(0);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(spy).not.toHaveBeenCalled();
    expect(order()).toHaveLength(1);
    expect(getState().lastSummary).toContain('ran locally');
    expect([getState().hasUnsyncedLocalEdits, getState().canUndo]).toEqual([true, true]);
  });

  it('offline undo / redo walk the local snapshot stack, which is bounded', () => {
    offline();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_box', { size: [2, 2, 2] });
    getState().undo();
    expect([order().length, getState().canRedo]).toEqual([1, true]);
    getState().undo();
    expect([order().length, getState().canUndo]).toEqual([0, false]);
    getState().redo();
    expect(order()).toHaveLength(1);
    getState().redo();
    expect([order().length, getState().canRedo]).toEqual([2, false]);
    for (let i = 0; i < 105; i++) getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(getState().localUndoStack).toHaveLength(100);
  });

  it('network errors while connecting fall back locally for dispatch and undo; HTTP 4xx does not', async () => {
    reject();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(order()).toHaveLength(1);
    expect(getState().liveStatus).toBe('disconnected');
    online();
    getState().undo();
    await flushPromises();
    expect(order()).toHaveLength(0);
    resetStore();
    online();
    httpStatus(400);
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(order()).toHaveLength(0);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().liveStatus).toBe('connected');
  });

  it('reconnect replays the offline outbox, then adopts the server snapshot', async () => {
    offline();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_sphere', { radius: 2 });
    const ids = getState().localOutbox.map((c) => c.commandId);
    expect(getState().localOutbox.map((c) => c.name)).toEqual(['add_box', 'add_sphere']);
    expect(new Set(ids).size).toBe(2);
    const server = simulatedServer();
    await reconnectTo(server);
    expect(server.commands()).toEqual(['add_box', 'add_sphere']);
    expect(server.bodies().map((b) => b.commandId)).toEqual(ids);
    expect(order()).toEqual(server.doc().order);
    expect(getState().liveSeq).toBe(2);
    expect(getState().localOutbox).toEqual([]);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
  });

  it('never replays a local-only restore (and its coalesced framing) to the server', async () => {
    offline();
    const restored = serializeDocument(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document);
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

  it('an offline undo drops its command from the outbox; redo re-queues it; undone ids are not re-minted', () => {
    offline();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_sphere', { radius: 2 });
    getState().undo();
    expect(getState().localOutbox.map((c) => c.name)).toEqual(['add_box']);
    getState().redo();
    expect(getState().localOutbox.map((c) => c.name)).toEqual(['add_box', 'add_sphere']);
    resetStore();
    offline();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const undoneId = order()[0]!;
    getState().undo();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(order()).toHaveLength(1);
    expect(order()[0]).not.toBe(undoneId);
  });

  it('a failed push keeps the local doc and the unsynced flag', async () => {
    offline();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    reject();
    hydrateEmpty();
    await flushPromises();
    expect(order()).toHaveLength(1);
    expect(getState().hasUnsyncedLocalEdits).toBe(true);
  });

  it('reconnect without local edits just hydrates and clears local stacks', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    useStore.setState({ localUndoStack: [createEmptyDocument()] });
    const result = localDispatch('add_box', { size: [1, 1, 1] });
    expect(spy).not.toHaveBeenCalled();
    expect(order()).toEqual(result.affected);
    expect(getState().localUndoStack).toHaveLength(0);
  });
});

describe('CadStore — sync races and outbox flush', () => {
  useCleanStoreHooks();

  it('select during push does not leave the unsynced flag set', async () => {
    makeOfflineEdit();
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);
    hydrateEmpty();
    getState().select([order()[0]!]);
    await idle();
    expect(server.commands()).toEqual(['add_box']);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
  });

  it('a failed push (HTTP 429) stays local, then the backoff retry succeeds', async () => {
    vi.useFakeTimers();
    makeOfflineEdit();
    const server = simulatedServer(429);
    vi.stubGlobal('fetch', server.fetch);
    hydrateEmpty();
    await vi.advanceTimersByTimeAsync(0);
    expect([getState().syncState, getState().hasUnsyncedLocalEdits, order().length]).toEqual(['failed', true, 1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.commands()).toEqual(['add_box']);
    expect([getState().syncState, getState().hasUnsyncedLocalEdits, order().length]).toEqual(['idle', false, 1]);
  });

  it('a live command arriving while the outbox flushes is superseded by the post-flush snapshot', async () => {
    makeOfflineEdit();
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);
    hydrateEmpty();
    expect(getState().syncState).toBe('syncing');
    expect(getState().applyLiveCommand({ epoch: TEST_EPOCH, seq: 99, name: 'add_box', params: {}, stateHash: 'x' })).toBe(true);
    await idle();
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(order()).toEqual(server.doc().order);
  });

  it('a POST network failure with SSE open neither goes offline nor runs locally', async () => {
    getState().setLiveStatus('connected');
    reject('flaky');
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(getState().liveStatus).toBe('connected');
    expect(order()).toHaveLength(0);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().lastSummary).toContain('not applied');
  });

  it.each(['add_box', 'add_sphere'])('a %s dispatched during the flush runs locally and joins the same flush', async (name) => {
    makeOfflineEdit();
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);
    hydrateEmpty();
    getState().dispatch(name, name === 'add_box' ? { size: [3, 3, 3] } : { radius: 2 });
    expect(order()).toHaveLength(2);
    await idle();
    expect(server.commands()).toEqual(['add_box', name]);
    expect(order()).toEqual(server.doc().order);
    expect(getState().hasUnsyncedLocalEdits).toBe(false);
    expect(getState().localOutbox).toEqual([]);
  });

  it('setDocument resets the unsynced counter and flags', () => {
    makeOfflineEdit();
    getState().setDocument(createEmptyDocument());
    expect([getState().hasUnsyncedLocalEdits, getState().localEditCounter, getState().syncState]).toEqual([false, 0, 'idle']);
  });

  it('live dispatch carries a commandId', async () => {
    online();
    const spy = mockFetch(DEFAULT_RESPONSE);
    getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as { commandId?: string };
    expect(typeof body.commandId).toBe('string');
    expect(body.commandId?.length).toBeGreaterThan(0);
  });

  it('undo/redo during a flush are refused and never touch the outbox', async () => {
    offline();
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_sphere', { radius: 2 });
    const queued = getState().localOutbox.map((entry) => entry.commandId);
    const server = simulatedServer();
    vi.stubGlobal('fetch', server.fetch);
    online();
    hydrateEmpty();
    expect(getState().syncState).toBe('syncing');
    getState().undo();
    getState().redo();
    expect(getState().lastSummary).toContain('Sync in progress');
    expect(getState().localOutbox.map((entry) => entry.commandId)).toEqual(queued);
    await idle();
    expect(server.commands()).toEqual(['add_box', 'add_sphere']);
    expect(order()).toEqual(server.doc().order);
  });

  it('flush remaps ids: a later move lands on the client box, not a concurrent agent box', async () => {
    const { server, agentBoxId, localBoxId } = offlineMoveBesideAgentBox();
    expect(agentBoxId).toBe(localBoxId);
    await reconnectTo(server, server.doc());
    expect(server.doc().order).toHaveLength(2);
    expectMoveOnClientBox(server.doc(), agentBoxId);
    expect(order()).toEqual(server.doc().order);
  });

  it('the id map survives a failed attempt (retry still remaps)', async () => {
    vi.useFakeTimers();
    const { server, agentBoxId } = offlineMoveBesideAgentBox();
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (!url.endsWith('/live/snapshot') && ++posts === 2) return Promise.reject(new Error('flaky'));
        return server.fetch(url, init);
      }),
    );
    online();
    getState().hydrateLiveDocument(liveSnapshot(server.doc()));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState().syncState).toBe('failed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(getState().syncState).toBe('idle');
    expectMoveOnClientBox(server.doc(), agentBoxId);
  });
});

describe('CadStore — live command log and epochs', () => {
  beforeEach(resetStore);

  it('applies the next broadcast command and keeps the local selection', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 3));
    const after = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const event = { epoch: TEST_EPOCH, seq: 4, name: 'add_box', params: { size: [1, 1, 1] }, stateHash: liveSnapshot(after).stateHash };
    expect(getState().applyLiveCommand(event)).toBe(true);
    expect(getState().liveSeq).toBe(4);
    getState().select([order()[0]!]);
    expect(getState().liveBase.selection).toEqual([]);
    expect(selection()).toHaveLength(1);
  });

  it('refuses a gap or a mismatching hash so the caller resyncs', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 3));
    expect(getState().applyLiveCommand({ epoch: TEST_EPOCH, seq: 9, name: 'add_box', params: {}, stateHash: '' })).toBe(false);
    expect(
      getState().applyLiveCommand({ epoch: TEST_EPOCH, seq: 4, name: 'add_box', params: { size: [1, 1, 1] }, stateHash: 'wrong' }),
    ).toBe(false);
    expect(getState().liveSeq).toBe(3);
  });

  it('orders snapshots by epoch and seq; replayed events are handled, foreign epochs are gaps', () => {
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 5));
    getState().hydrateLiveDocument(liveSnapshot(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document, 3));
    expect(getState().liveSeq).toBe(5);
    expect(order()).toHaveLength(0);
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 5));
    expect(getState().liveSeq).toBe(5);
    const event = { epoch: TEST_EPOCH, seq: 5, name: 'add_box', params: {}, stateHash: 'x' };
    expect(getState().applyLiveCommand(event)).toBe(true);
    expect(getState().applyLiveCommand({ ...event, seq: 2 })).toBe(true);
    expect(getState().liveSeq).toBe(5);
    expect(getState().applyLiveCommand({ ...event, epoch: 'other', seq: 6 })).toBe(false);
    getState().hydrateLiveDocument(liveSnapshot(createEmptyDocument(), 0, 'restarted'));
    expect([getState().liveSeq, getState().liveEpoch]).toEqual([0, 'restarted']);
  });
});
