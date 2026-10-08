/**
 * Selection actions that issue several commands are one local undo step: a mixed
 * (building element + plain entity) delete / move, and a held arrow key's repeated nudges.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { deleteSelection, moveSelection } from '@ui/actions/selectionActions';

const state = (): ReturnType<typeof useStore.getState> => useStore.getState();

function buildingEntityId(): string {
  const building = state().document.building;
  const element = Object.values(building?.elements ?? {})[0];
  return element!.entityIds[0]!;
}

describe('selection actions and undo steps', () => {
  beforeEach(() => {
    state().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
  });

  it('repeated nudges marked joinPrevious (held arrow key) undo in one step', () => {
    state().dispatch('add_box', { size: [1, 1, 1] });
    const id = state().document.order[0]!;
    state().select([id]);
    moveSelection([1, 0, 0]);
    moveSelection([1, 0, 0], { joinPrevious: true });
    moveSelection([1, 0, 0], { joinPrevious: true });
    expect(state().document.entities[id]?.position[0]).toBeCloseTo(3);
    state().undo();
    expect(state().document.entities[id]?.position[0]).toBeCloseTo(0);
  });

  it('a mixed delete (building element + plain entity) is one undo step', () => {
    state().dispatch('add_building_template', { template: 'house' });
    state().dispatch('add_box', { size: [1, 1, 1], position: [50, 50, 0] });
    const boxId = state().document.order[state().document.order.length - 1]!;
    const before = state().document.order.length;
    state().select([buildingEntityId(), boxId]);

    deleteSelection();
    expect(state().document.order.length).toBeLessThan(before);

    state().undo();
    expect(state().document.order.length).toBe(before);
  });
});
