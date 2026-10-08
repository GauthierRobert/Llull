/**
 * Outbox vs permanent HTTP errors (architecture L6): a command the server refuses (400/413/422)
 * is dropped from the outbox and reported, so it can never wedge the flush; transient failures
 * (5xx, 429, 408) keep the entry and retry with backoff; connection refusals (401/403/404) keep
 * the whole outbox and the local document.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { CONNECT_GRACE_MS } from '@ui/store/onlineMode';
import { liveSnapshot } from '../helpers/storeTestHelpers';

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const httpFail = (status: number): FakeResponse => ({
  ok: false,
  status,
  json: () => Promise.resolve({}),
});

/**
 * Simulated server. `refuse(name)` returns an HTTP status to answer instead of applying the
 * command; `hold` parks the next /command POST until `release()` settles it.
 */
function scriptedServer(
  refuse: (name: string, attempt: number) => number | undefined,
  initialDoc: CadDocument = createEmptyDocument(),
): {
  fetch: ReturnType<typeof vi.fn>;
  applied: () => string[];
  doc: () => CadDocument;
  holdNext: () => void;
  release: () => void;
} {
  let serverDoc = initialDoc;
  let seq = 0;
  const applied: string[] = [];
  const attempts = new Map<string, number>();
  let holding = false;
  let held: (() => void) | null = null;
  const answer = (name: string, params: unknown): FakeResponse => {
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    const status = refuse(name, attempt);
    if (status !== undefined) return httpFail(status);
    const result = execute(serverDoc, name, params);
    if (result.document !== serverDoc) seq += 1;
    serverDoc = result.document;
    applied.push(name);
    const body = { summary: result.summary, affected: result.affected, isError: false };
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...body, canUndo: true, canRedo: false }),
    };
  };
  const fetch = vi.fn((url: string, init?: RequestInit): Promise<FakeResponse> => {
    if (url.endsWith('/live/snapshot')) {
      const snapshot = liveSnapshot(serverDoc, seq);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(snapshot) });
    }
    const body = JSON.parse(init?.body as string) as { name: string; params: unknown };
    if (!holding) return Promise.resolve(answer(body.name, body.params));
    holding = false;
    return new Promise((resolve) => (held = () => resolve(answer(body.name, body.params))));
  });
  return {
    fetch,
    applied: () => applied,
    doc: () => serverDoc,
    holdNext: () => (holding = true),
    release: () => held?.(),
  };
}

function resetStore(liveStatus: 'connecting' | 'disconnected'): void {
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({
    liveStatus,
    sseEverConnected: false,
    hasUnsyncedLocalEdits: false,
    syncState: 'idle',
    liveEpoch: null,
    liveSeq: -1,
    liveBase: createEmptyDocument(),
  });
}

const state = (): ReturnType<typeof useStore.getState> => useStore.getState();

describe('outbox — permanent HTTP errors', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    state().setDocument(createEmptyDocument());
  });

  it('a grace-run command later refused with 413 leaves the outbox, and later commands sync', async () => {
    resetStore('connecting');
    const server = scriptedServer((name) => (name === 'add_box' ? 413 : undefined));
    vi.stubGlobal('fetch', server.fetch);

    server.holdNext();
    state().dispatch('add_box', { size: [1, 1, 1] });
    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS);
    expect(state().localOutbox.map((entry) => entry.name)).toEqual(['add_box']);

    server.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().localOutbox).toHaveLength(0);
    expect(state().lastSummary).toContain('HTTP 413');

    state().dispatch('add_sphere', { radius: 1 });
    expect(state().localOutbox.map((entry) => entry.name)).toEqual(['add_sphere']);

    state().setLiveStatus('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.applied()).toEqual(['add_sphere']);
    expect(state().syncState).toBe('idle');
    expect(state().hasUnsyncedLocalEdits).toBe(false);
    expect(state().document.order).toEqual(server.doc().order);
  });

  it('flushOutbox drops a permanently refused entry, reports it, and syncs the rest', async () => {
    resetStore('disconnected');
    state().dispatch('add_box', { size: [1, 1, 1] });
    state().dispatch('add_sphere', { radius: 1 });
    expect(state().localOutbox).toHaveLength(2);
    const server = scriptedServer((name) => (name === 'add_box' ? 413 : undefined));
    vi.stubGlobal('fetch', server.fetch);

    state().setLiveStatus('connected');
    await vi.advanceTimersByTimeAsync(0);

    expect(server.applied()).toEqual(['add_sphere']);
    expect(state().localOutbox).toHaveLength(0);
    expect(state().syncState).toBe('idle');
    expect(state().hasUnsyncedLocalEdits).toBe(false);
    expect(state().lastSummary).toContain('refused 1');
    expect(state().lastSummary).toContain("'add_box'");
    expect(state().document.order).toEqual(server.doc().order);
  });

  it.each([500, 429, 408])('a transient HTTP %i keeps the entry and retries', async (status) => {
    resetStore('disconnected');
    state().dispatch('add_box', { size: [1, 1, 1] });
    const server = scriptedServer((_name, attempt) => (attempt === 1 ? status : undefined));
    vi.stubGlobal('fetch', server.fetch);

    state().setLiveStatus('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(state().syncState).toBe('failed');
    expect(state().localOutbox).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(server.applied()).toEqual(['add_box']);
    expect(state().localOutbox).toHaveLength(0);
    expect(state().syncState).toBe('idle');
  });

  it('drops later entries that reference an id created by a refused entry (no server edit)', async () => {
    const seeded = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const serverBoxId = seeded.affected[0] ?? '';
    resetStore('disconnected');
    state().dispatch('add_box', { size: [1, 1, 1] });
    const localBoxId = state().localOutbox[0]?.affected[0];
    expect(localBoxId).toBe(serverBoxId); // the raw local id would hit an unrelated server box
    state().dispatch('move_entity', { id: localBoxId, delta: [5, 0, 0] });
    state().dispatch('add_sphere', { radius: 1 });
    const server = scriptedServer(
      (name) => (name === 'add_box' ? 413 : undefined),
      seeded.document,
    );
    vi.stubGlobal('fetch', server.fetch);

    state().setLiveStatus('connected');
    await vi.advanceTimersByTimeAsync(0);

    expect(server.applied()).toEqual(['add_sphere']);
    expect(server.doc().entities[serverBoxId]?.position).toEqual(
      seeded.document.entities[serverBoxId]?.position,
    );
    expect(state().localOutbox).toHaveLength(0);
    expect(state().syncState).toBe('idle');
    expect(state().lastSummary).toContain('refused 2');
    expect(state().lastSummary).toContain("'move_entity' (depends on refused 'add_box')");
  });

  it('a refused grace-run add_box poisons its id for the queued move_entity', async () => {
    const seeded = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const serverBoxId = seeded.affected[0] ?? '';
    resetStore('connecting');
    const server = scriptedServer(
      (name) => (name === 'add_box' ? 413 : undefined),
      seeded.document,
    );
    vi.stubGlobal('fetch', server.fetch);

    server.holdNext();
    state().dispatch('add_box', { size: [1, 1, 1] });
    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS);
    const localBoxId = state().localOutbox[0]?.affected[0];
    expect(localBoxId).toBe(serverBoxId);
    server.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().localOutbox).toHaveLength(0);

    state().dispatch('move_entity', { id: localBoxId, delta: [5, 0, 0] });
    expect(state().localOutbox.map((entry) => entry.name)).toEqual(['move_entity']);
    state().setLiveStatus('connected');
    await vi.advanceTimersByTimeAsync(0);

    expect(server.applied()).toEqual([]);
    expect(server.doc().entities[serverBoxId]?.position).toEqual(
      seeded.document.entities[serverBoxId]?.position,
    );
    expect(state().lastSummary).toContain("depends on refused 'add_box'");
  });

  it('a refused edit of a server-held entity does not poison it for later entries', async () => {
    const seeded = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const serverBoxId = seeded.affected[0] ?? '';
    resetStore('disconnected');
    useStore.setState({ liveBase: seeded.document, document: seeded.document });
    state().dispatch('move_entity', { id: serverBoxId, delta: [1, 0, 0] });
    state().dispatch('move_entity', { id: serverBoxId, delta: [0, 1, 0] });
    const server = scriptedServer(
      (name, attempt) => (name === 'move_entity' && attempt === 1 ? 422 : undefined),
      seeded.document,
    );
    vi.stubGlobal('fetch', server.fetch);

    state().setLiveStatus('connected');
    await vi.advanceTimersByTimeAsync(0);

    expect(server.applied()).toEqual(['move_entity']);
    expect(state().lastSummary).toContain('refused 1');
  });

  it.each([403, 401, 404])(
    'a %i on every POST keeps both entries and the local document',
    async (status) => {
      resetStore('disconnected');
      state().dispatch('add_box', { size: [1, 1, 1] });
      state().dispatch('add_sphere', { radius: 1 });
      const localOrder = state().document.order;
      expect(localOrder).toHaveLength(2);
      const server = scriptedServer(() => status);
      vi.stubGlobal('fetch', server.fetch);

      state().setLiveStatus('connected');
      await vi.advanceTimersByTimeAsync(0);
      expect(state().localOutbox.map((entry) => entry.name)).toEqual(['add_box', 'add_sphere']);
      expect(state().document.order).toEqual(localOrder);
      expect(state().hasUnsyncedLocalEdits).toBe(true);
      expect(state().syncState).toBe('failed');
      expect(state().lastSummary).toContain('refused the connection (auth/origin)');
      expect(state().lastSummary).toContain('offline edits kept');

      const callsBeforeRetry = server.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.fetch.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
      expect(state().localOutbox).toHaveLength(2);
      expect(state().document.order).toEqual(localOrder);
      expect(server.applied()).toEqual([]);
    },
  );

  it('a grace-run command answered with 403 stays queued and the edit is kept', async () => {
    resetStore('connecting');
    const server = scriptedServer(() => 403);
    vi.stubGlobal('fetch', server.fetch);

    server.holdNext();
    state().dispatch('add_box', { size: [1, 1, 1] });
    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS);
    server.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().localOutbox.map((entry) => entry.name)).toEqual(['add_box']);
    expect(state().document.order).toHaveLength(1);
    expect(state().lastSummary).toContain('offline edits kept');
  });

  it('a grace-run command answered with a transient 500 stays queued for the flush', async () => {
    resetStore('connecting');
    const server = scriptedServer((_name, attempt) => (attempt === 1 ? 500 : undefined));
    vi.stubGlobal('fetch', server.fetch);

    server.holdNext();
    state().dispatch('add_box', { size: [1, 1, 1] });
    await vi.advanceTimersByTimeAsync(CONNECT_GRACE_MS);
    server.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().localOutbox).toHaveLength(1);

    state().setLiveStatus('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.applied()).toEqual(['add_box']);
    expect(state().syncState).toBe('idle');
  });
});
