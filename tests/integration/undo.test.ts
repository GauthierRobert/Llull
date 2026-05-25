/**
 * Integration tests for undo/redo history in the Zustand CAD store.
 *
 * Covers:
 *   - undo restores the prior document; redo re-applies it
 *   - multiple dispatches then repeated undo/redo walks history correctly
 *   - a graceful no-op dispatch does NOT push onto undoStack
 *   - a new dispatch after undo clears the redo stack
 *   - setDocument clears both stacks
 *   - undo/redo are no-ops when the respective stack is empty
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';

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
    undoStack: [],
    redoStack: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('undo/redo history', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('undo after add_box reverts the document to empty', () => {
    const emptyDoc = getState().document;

    getState().dispatch('add_box', { size: [2, 2, 2] });
    expect(getState().document.order).toHaveLength(1);

    getState().undo();
    expect(getState().document).toBe(emptyDoc);
    expect(getState().document.order).toHaveLength(0);
  });

  it('redo after undo re-applies the command result', () => {
    getState().dispatch('add_box', { size: [2, 2, 2] });
    const docWithBox = getState().document;

    getState().undo();
    expect(getState().document.order).toHaveLength(0);

    getState().redo();
    expect(getState().document).toBe(docWithBox);
    expect(getState().document.order).toHaveLength(1);
  });

  it('multiple dispatches then repeated undo walks history step by step', () => {
    const doc0 = getState().document;

    getState().dispatch('add_box', { size: [1, 1, 1] });
    const doc1 = getState().document;

    getState().dispatch('add_box', { size: [2, 2, 2] });
    const doc2 = getState().document;

    getState().dispatch('add_box', { size: [3, 3, 3] });
    expect(getState().document.order).toHaveLength(3);

    getState().undo();
    expect(getState().document).toBe(doc2);

    getState().undo();
    expect(getState().document).toBe(doc1);

    getState().undo();
    expect(getState().document).toBe(doc0);

    // Stack exhausted — further undo is a no-op
    getState().undo();
    expect(getState().document).toBe(doc0);
  });

  it('repeated redo walks back through undone steps', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const doc1 = getState().document;
    getState().dispatch('add_box', { size: [2, 2, 2] });
    const doc2 = getState().document;
    getState().dispatch('add_box', { size: [3, 3, 3] });
    const doc3 = getState().document;

    getState().undo();
    getState().undo();
    getState().undo();

    getState().redo();
    expect(getState().document).toBe(doc1);

    getState().redo();
    expect(getState().document).toBe(doc2);

    getState().redo();
    expect(getState().document).toBe(doc3);

    // Stack exhausted — further redo is a no-op
    getState().redo();
    expect(getState().document).toBe(doc3);
  });

  it('a graceful no-op dispatch does NOT push onto undoStack', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const docWithBox = getState().document;
    expect(getState().undoStack).toHaveLength(1);

    // move_entity on a missing id is a graceful no-op (returns same doc)
    getState().dispatch('move_entity', { id: 'nonexistent-id', delta: [0, 0, 0] });

    // undoStack must still be length 1 — no-op did not push
    expect(getState().undoStack).toHaveLength(1);
    expect(getState().document).toBe(docWithBox);

    // undo should recover the state before add_box, not some phantom state
    getState().undo();
    expect(getState().document.order).toHaveLength(0);
  });

  it('a new dispatch after undo clears the redo stack', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_box', { size: [2, 2, 2] });

    getState().undo(); // redoStack now has one entry
    expect(getState().redoStack).toHaveLength(1);

    // Dispatch a new command — redo stack must be cleared
    getState().dispatch('add_box', { size: [3, 3, 3] });
    expect(getState().redoStack).toHaveLength(0);

    // redo is now a no-op
    const docAfterNewDispatch = getState().document;
    getState().redo();
    expect(getState().document).toBe(docAfterNewDispatch);
  });

  it('setDocument clears both undoStack and redoStack', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    getState().dispatch('add_box', { size: [2, 2, 2] });
    getState().undo();

    expect(getState().undoStack.length).toBeGreaterThan(0);
    expect(getState().redoStack.length).toBeGreaterThan(0);

    const fresh = createEmptyDocument();
    getState().setDocument(fresh);

    expect(getState().undoStack).toHaveLength(0);
    expect(getState().redoStack).toHaveLength(0);
    expect(getState().document).toBe(fresh);
  });

  it('undo is a no-op when undoStack is empty', () => {
    const doc = getState().document;
    getState().undo();
    expect(getState().document).toBe(doc);
  });

  it('redo is a no-op when redoStack is empty', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const doc = getState().document;
    getState().redo();
    expect(getState().document).toBe(doc);
  });

  it('undoStack and redoStack lengths reflect current history depth', () => {
    expect(getState().undoStack).toHaveLength(0);
    expect(getState().redoStack).toHaveLength(0);

    getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(getState().undoStack).toHaveLength(1);
    expect(getState().redoStack).toHaveLength(0);

    getState().undo();
    expect(getState().undoStack).toHaveLength(0);
    expect(getState().redoStack).toHaveLength(1);

    getState().redo();
    expect(getState().undoStack).toHaveLength(1);
    expect(getState().redoStack).toHaveLength(0);
  });

  it('unknown command (no-op) does not push to undoStack', () => {
    getState().dispatch('add_box', { size: [1, 1, 1] });
    const stackLengthBefore = getState().undoStack.length;

    getState().dispatch('totally_unknown_command', {});

    expect(getState().undoStack).toHaveLength(stackLengthBefore);
  });
});
