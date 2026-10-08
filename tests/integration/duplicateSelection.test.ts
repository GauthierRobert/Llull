/**
 * Duplicating a multi-entity selection is one duplicate_entities command, so it is a single undo
 * step locally and online alike.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { duplicateSelection } from '@ui/actions/selectionActions';

describe('duplicateSelection', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
  });

  it('copies every selected entity and one undo removes all the copies', () => {
    const { dispatch } = useStore.getState();
    dispatch('add_box', { size: [1, 1, 1] });
    dispatch('add_box', { size: [1, 1, 1], position: [5, 0, 0] });
    dispatch('add_box', { size: [1, 1, 1], position: [10, 0, 0] });
    const ids = useStore.getState().document.order;
    useStore.getState().select([...ids]);

    duplicateSelection();
    expect(useStore.getState().document.order).toHaveLength(6);
    expect(useStore.getState().document.featureHistory.at(-1)?.name).toBe('duplicate_entities');

    useStore.getState().undo();
    expect(useStore.getState().document.order).toHaveLength(3);
  });

  it('dispatches a single duplicate_entities with the selection ids and a clearing offset', () => {
    useStore.getState().dispatch('add_box', { size: [2, 1, 1] });
    useStore.getState().dispatch('add_box', { size: [1, 1, 1], position: [5, 0, 0] });
    const ids = [...useStore.getState().document.order];
    useStore.getState().select(ids);
    const realDispatch = useStore.getState().dispatch;
    const dispatch = vi.fn();
    useStore.setState({ dispatch });

    duplicateSelection();
    useStore.setState({ dispatch: realDispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
    // Selection spans x -1..5.5; copies land one gap (1.5) beyond that width.
    expect(dispatch).toHaveBeenCalledWith(
      'duplicate_entities',
      { ids, offset: [8, 0, 0] },
      { selectAffected: false },
    );
  });

  it('selects the copy of a single selected entity', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    const [original] = useStore.getState().document.order;
    useStore.getState().select([original!]);

    duplicateSelection();

    const { order, selection } = useStore.getState().document;
    expect(selection).toEqual([order[1]]);
  });

  it('does nothing without a selection', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    useStore.getState().clearSelection();
    duplicateSelection();
    expect(useStore.getState().document.order).toHaveLength(1);
  });
});
