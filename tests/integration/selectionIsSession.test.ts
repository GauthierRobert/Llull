import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';

const state = (): ReturnType<typeof useStore.getState> => useStore.getState();

describe('selection is session state routed through set_selection', () => {
  beforeEach(() => {
    state().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
  });
  it('select / toggle / clear / dispatch change the selection without undo entries', () => {
    state().dispatch('add_box', { size: [1, 1, 1] });
    state().dispatch('add_box', { size: [1, 1, 1] });
    const [a, b] = state().document.order as [string, string];
    const undoDepth = state().localUndoStack.length;
    state().select([a]);
    expect(state().document.selection).toEqual([a]);
    state().toggleSelection(b);
    expect(state().document.selection).toEqual([a, b]);
    state().dispatch('set_selection', { ids: [b], mode: 'replace' });
    expect(state().document.selection).toEqual([b]);
    state().clearSelection();
    expect(state().document.selection).toEqual([]);
    expect(state().localUndoStack.length).toBe(undoDepth);
    expect(state().document.featureHistory.length).toBe(2);
  });
  it('online mode keeps selection local (no POST)', () => {
    state().dispatch('add_box', { size: [1, 1, 1] });
    const id = state().document.order[0]!;
    useStore.setState({ liveStatus: 'connected' });
    state().select([id]);
    expect(state().document.selection).toEqual([id]);
  });
});
