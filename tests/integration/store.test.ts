/**
 * Integration tests for the Zustand CAD store.
 *
 * These tests exercise the store's public contract:
 *   - dispatch() routes through execute() and updates the document
 *   - unknown commands are safe no-ops leaving the document unchanged
 *   - selection helpers mutate document.selection immutably
 *   - setDocument() replaces the whole document
 *
 * Geometry math is NOT tested here — that belongs in tests/unit/commands.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers — access the store's raw API without React
// ---------------------------------------------------------------------------

function getState(): ReturnType<typeof useStore.getState> {
  return useStore.getState();
}

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CadStore', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  // ── dispatch ──────────────────────────────────────────────────────────────

  it('dispatch add_box creates an entity and updates the document', () => {
    const result = getState().dispatch('add_box', { size: [2, 2, 2] });

    expect(result.affected).toHaveLength(1);
    expect(result.summary).toBeTruthy();

    const { document } = getState();
    expect(document.order).toHaveLength(1);

    const id = result.affected[0]!;
    expect(document.entities[id]).toBeDefined();
    expect(document.entities[id]!.kind).toBe('box');
  });

  it('dispatch returns the full CommandResult with affected ids', () => {
    const result = getState().dispatch('add_box', { size: [1, 2, 3] });

    expect(result.affected).toHaveLength(1);
    expect(typeof result.affected[0]).toBe('string');
    expect(result.document).toBe(getState().document);
  });

  it('dispatch updates lastSummary after each call', () => {
    expect(getState().lastSummary).toBeNull();

    getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(getState().lastSummary).toBeTruthy();
  });

  it('dispatch with unknown command is a safe no-op — document unchanged, summary set', () => {
    const docBefore = getState().document;
    const result = getState().dispatch('totally_unknown_command', {});

    // document reference must be the same (no-op)
    expect(getState().document).toBe(docBefore);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('Unknown command');
    // lastSummary is still set (useful for the UI to report the error)
    expect(getState().lastSummary).toContain('Unknown command');
  });

  it('successive dispatches accumulate entities', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_box', { size: [2, 2, 2] });

    expect(getState().document.order).toHaveLength(2);
  });

  // ── setDocument ───────────────────────────────────────────────────────────

  it('setDocument replaces the document and resets lastSummary', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(getState().document.order).toHaveLength(1);
    expect(getState().lastSummary).toBeTruthy();

    const fresh = createEmptyDocument();
    getState().setDocument(fresh);

    expect(getState().document).toBe(fresh);
    expect(getState().document.order).toHaveLength(0);
    expect(getState().lastSummary).toBeNull();
  });

  // ── select ────────────────────────────────────────────────────────────────

  it('select sets document.selection to the provided ids', () => {
    const r = getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().select([id]);
    expect(getState().document.selection).toEqual([id]);
  });

  it('select replaces the entire selection (not additive)', () => {
    const r1 = getState().dispatch('add_box', { size: [1, 1, 1] });
    const r2 = getState().dispatch('add_box', { size: [2, 2, 2] });
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;

    getState().select([id1]);
    getState().select([id2]);

    expect(getState().document.selection).toEqual([id2]);
  });

  it('select is immutable — previous document is not mutated', () => {
    const r = getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;
    const docBefore = getState().document;

    getState().select([id]);

    // a new document object must have been produced
    expect(getState().document).not.toBe(docBefore);
    // and the old document's selection must be untouched
    expect(docBefore.selection).toEqual([]);
  });

  // ── toggleSelection ───────────────────────────────────────────────────────

  it('toggleSelection adds an id that is not currently selected', () => {
    const r = getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().toggleSelection(id);
    expect(getState().document.selection).toContain(id);
  });

  it('toggleSelection removes an id that is already selected', () => {
    const r = getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().select([id]);
    getState().toggleSelection(id);
    expect(getState().document.selection).not.toContain(id);
  });

  it('toggleSelection preserves other selected ids', () => {
    const r1 = getState().dispatch('add_box', { size: [1, 1, 1] });
    const r2 = getState().dispatch('add_box', { size: [2, 2, 2] });
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;

    getState().select([id1, id2]);
    getState().toggleSelection(id1);

    expect(getState().document.selection).toEqual([id2]);
  });

  // ── clearSelection ────────────────────────────────────────────────────────

  it('clearSelection empties document.selection', () => {
    const r = getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = r.affected[0]!;

    getState().select([id]);
    expect(getState().document.selection).toHaveLength(1);

    getState().clearSelection();
    expect(getState().document.selection).toHaveLength(0);
  });

  it('clearSelection is a no-op when nothing is selected', () => {
    const docBefore = getState().document;
    getState().clearSelection();
    // document reference MAY differ (new object) but selection must still be empty
    expect(getState().document.selection).toEqual([]);
    // and the entities are untouched
    expect(getState().document.entities).toEqual(docBefore.entities);
  });
});
