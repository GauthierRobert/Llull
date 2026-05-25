/**
 * @layer server/tests
 *
 * Unit tests for commandBus.ts
 *
 * Covers:
 *   (a) applyCommand — mutating command updates live doc + pushes undo history.
 *   (b) applyCommand — query command (measure_volume) returns data, no history/broadcast.
 *   (c) applyCommand — no-op (graceful bad params) pushes nothing.
 *   (d) applyCommand — unknown command → isError true, doc unchanged.
 *   (e) undo/redo — move through history, update canUndo/canRedo.
 *   (f) canUndo / canRedo — state reflects stack sizes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyCommand,
  undo,
  redo,
  canUndo,
  canRedo,
  _resetHistory,
} from '../src/commandBus';
import { getLiveDoc, _resetLiveDoc, subscribeLive } from '../src/liveDocument';

// ---------------------------------------------------------------------------
// Minimal fake Express Response for broadcast-capture tests.
// ---------------------------------------------------------------------------

interface FakeResponse {
  written: string[];
  ended: boolean;
  write(chunk: string): boolean;
  end(): void;
}

function makeFakeRes(): FakeResponse {
  return {
    written: [],
    ended: false,
    write(chunk: string): boolean {
      this.written.push(chunk);
      return true;
    },
    end(): void {
      this.ended = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Reset shared state before each test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

// ---------------------------------------------------------------------------
// (a) Mutating command updates live doc + pushes undo history
// ---------------------------------------------------------------------------

describe('applyCommand — mutating command', () => {
  it('adds an entity to the live document', () => {
    const result = applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });

    expect(result.isError).toBe(false);
    expect(result.affected).toHaveLength(1);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);
  });

  it('updates canUndo to true after a mutation', () => {
    const result = applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    expect(result.canUndo).toBe(true);
    expect(result.canRedo).toBe(false);
  });

  it('accumulates entities across successive calls', () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    applyCommand('add_box', { size: [2, 2, 2], position: [5, 0, 0] });

    expect(Object.keys(getLiveDoc().entities)).toHaveLength(2);
    expect(canUndo()).toBe(true);
  });

  it('broadcasts to SSE subscribers after a mutation', () => {
    const fakeRes = makeFakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeLive(fakeRes as any);

    // Initial snapshot write (1 total).
    expect(fakeRes.written).toHaveLength(1);

    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });

    // Mutation broadcast (2 total).
    expect(fakeRes.written).toHaveLength(2);

    const msg = fakeRes.written[1] ?? '';
    const parsed = JSON.parse(msg.slice('data: '.length)) as Record<string, unknown>;
    const entities = parsed['entities'] as Record<string, unknown>;
    expect(Object.keys(entities)).toHaveLength(1);

    unsub();
  });
});

// ---------------------------------------------------------------------------
// (b) Query command — data returned, no history push, no doc change
// ---------------------------------------------------------------------------

describe('applyCommand — query command (measure_volume)', () => {
  it('returns data and leaves the live document unchanged', () => {
    // First add a box so there is something to measure.
    applyCommand('add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    _resetHistory(); // reset so we start clean for the query test

    const docBefore = getLiveDoc();
    const entityIds = Object.keys(docBefore.entities);
    expect(entityIds).toHaveLength(1);

    const result = applyCommand('measure_volume', { entityId: entityIds[0] });

    expect(result.isError).toBe(false);
    expect(result.data).toBeDefined();
    // Document reference must be identical — no mutation.
    expect(getLiveDoc()).toBe(docBefore);
    // History was not pushed — canUndo is still false after reset.
    expect(result.canUndo).toBe(false);
  });

  it('does not broadcast to SSE subscribers for a query', () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    const entityId = Object.keys(getLiveDoc().entities)[0] ?? '';

    const fakeRes = makeFakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeLive(fakeRes as any);
    const writeCountBefore = fakeRes.written.length;

    applyCommand('measure_volume', { entityId });

    // No additional write after the query.
    expect(fakeRes.written).toHaveLength(writeCountBefore);

    unsub();
  });
});

// ---------------------------------------------------------------------------
// (c) No-op — graceful bad params, no history push
// ---------------------------------------------------------------------------

describe('applyCommand — no-op (bad params)', () => {
  it('does not push history when the document is unchanged', () => {
    // delete_entity with a non-existent id is a graceful no-op.
    const result = applyCommand('delete_entity', { id: 'nonexistent-id' });

    expect(result.isError).toBe(false);
    expect(getLiveDoc()).toBeDefined();
    // No history pushed — canUndo remains false.
    expect(result.canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) Unknown command → isError true
// ---------------------------------------------------------------------------

describe('applyCommand — unknown command', () => {
  it('returns isError true and leaves the doc unchanged', () => {
    const docBefore = getLiveDoc();
    const result = applyCommand('totally_unknown_command', {});

    expect(result.isError).toBe(true);
    expect(getLiveDoc()).toBe(docBefore);
    expect(result.canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) undo / redo
// ---------------------------------------------------------------------------

describe('undo / redo', () => {
  it('undo with empty stack returns "Nothing to undo." without error', () => {
    const result = undo();
    expect(result.isError).toBe(false);
    expect(result.summary).toBe('Nothing to undo.');
    expect(result.canUndo).toBe(false);
  });

  it('redo with empty stack returns "Nothing to redo." without error', () => {
    const result = redo();
    expect(result.isError).toBe(false);
    expect(result.summary).toBe('Nothing to redo.');
    expect(result.canRedo).toBe(false);
  });

  it('undo reverts the last mutation', () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);

    const undoResult = undo();
    expect(undoResult.summary).toBe('Undid last change.');
    expect(undoResult.canRedo).toBe(true);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
  });

  it('redo re-applies the undone mutation', () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    undo();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);

    const redoResult = redo();
    expect(redoResult.summary).toBe('Redid last change.');
    expect(redoResult.canUndo).toBe(true);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);
  });

  it('redo stack is cleared after a new mutation', () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    undo();
    expect(canRedo()).toBe(true);

    // New mutation clears redo.
    applyCommand('add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    expect(canRedo()).toBe(false);
  });

  it('undo/redo update canUndo/canRedo correctly through a sequence', () => {
    // 2 mutations.
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    applyCommand('add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);

    // Undo once.
    const u1 = undo();
    expect(u1.canUndo).toBe(true);   // still 1 step left
    expect(u1.canRedo).toBe(true);

    // Undo again.
    const u2 = undo();
    expect(u2.canUndo).toBe(false);  // stack empty
    expect(u2.canRedo).toBe(true);

    // Redo once.
    const r1 = redo();
    expect(r1.canUndo).toBe(true);
    expect(r1.canRedo).toBe(true);
  });

  it('undo broadcasts the restored document to SSE subscribers', () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });

    const fakeRes = makeFakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeLive(fakeRes as any);
    const writesBefore = fakeRes.written.length;

    undo();

    // Undo should broadcast (1 extra write).
    expect(fakeRes.written).toHaveLength(writesBefore + 1);

    const msg = fakeRes.written[fakeRes.written.length - 1] ?? '';
    const parsed = JSON.parse(msg.slice('data: '.length)) as Record<string, unknown>;
    const entities = parsed['entities'] as Record<string, unknown>;
    // Undo reverted the add_box → 0 entities.
    expect(Object.keys(entities)).toHaveLength(0);

    unsub();
  });
});

// ---------------------------------------------------------------------------
// (f) canUndo / canRedo module-level helpers
// ---------------------------------------------------------------------------

describe('canUndo / canRedo', () => {
  it('start false on a clean state', () => {
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('canUndo becomes true after a mutation, false after undo to bottom', () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    expect(canUndo()).toBe(true);
    undo();
    expect(canUndo()).toBe(false);
  });
});
