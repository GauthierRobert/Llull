/** The shared undo / redo rule (backend live document + offline renderer): bounded stacks, redo cleared by a change, symmetric steps. */

import { describe, expect, it } from 'vitest';
import { emptyHistory, historySummary, recordChange, stepHistory } from '@protocol/history';

describe('history reducer', () => {
  it('records a change on the undo stack and clears redo', () => {
    const afterUndo = stepHistory(recordChange(emptyHistory<number>(), 1), 'undo', 2);
    expect(afterUndo).toEqual({ target: 1, history: { undo: [], redo: [2] } });
    expect(recordChange(afterUndo!.history, 2)).toEqual({ undo: [2], redo: [] });
  });

  it('steps back and forth, parking the current snapshot on the opposite stack', () => {
    const history = recordChange(recordChange(emptyHistory<number>(), 1), 2);
    const undone = stepHistory(history, 'undo', 3)!;
    expect(undone).toEqual({ target: 2, history: { undo: [1], redo: [3] } });
    expect(stepHistory(undone.history, 'redo', 2)).toEqual({ target: 3, history: { undo: [1, 2], redo: [] } });
  });

  it('answers null on an empty stack and never mutates its input', () => {
    const history = Object.freeze({ undo: Object.freeze([1]), redo: Object.freeze([]) });
    expect(stepHistory(history, 'redo', 2)).toBeNull();
    expect(stepHistory(history, 'undo', 2)).not.toBeNull();
    expect(history).toEqual({ undo: [1], redo: [] });
  });

  it('caps both stacks at 100 entries, oldest dropped', () => {
    let history = emptyHistory<number>();
    for (let i = 0; i < 150; i++) history = recordChange(history, i);
    expect(history.undo).toHaveLength(100);
    expect(history.undo[0]).toBe(50);
    let redo = history;
    for (let i = 0; i < 100; i++) redo = stepHistory(redo, 'undo', 1000 + i)!.history;
    expect(redo.redo).toHaveLength(100);
    const full = { undo: history.undo, redo: history.undo };
    expect(stepHistory(full, 'redo', -1)!.history.undo).toHaveLength(100);
  });

  it('coalesces into the previous entry only when there is one', () => {
    expect(recordChange(emptyHistory<number>(), 1, true)).toEqual({ undo: [1], redo: [] });
    expect(recordChange({ undo: [1], redo: [9] }, 2, true)).toEqual({ undo: [1], redo: [] });
  });

  it('words the results once for both hosts', () => {
    expect(historySummary('undo', true)).toBe('Undid last change.');
    expect(historySummary('redo', true)).toBe('Redid last change.');
    expect(historySummary('undo', false)).toBe('Nothing to undo.');
    expect(historySummary('redo', false)).toBe('Nothing to redo.');
  });
});
