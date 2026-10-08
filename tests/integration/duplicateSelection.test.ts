/**
 * Duplicating a multi-entity selection issues one duplicate_entity per entity but is a single
 * undo step locally.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

    useStore.getState().undo();
    expect(useStore.getState().document.order).toHaveLength(3);
  });

  it('does nothing without a selection', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    useStore.getState().clearSelection();
    duplicateSelection();
    expect(useStore.getState().document.order).toHaveLength(1);
  });
});
