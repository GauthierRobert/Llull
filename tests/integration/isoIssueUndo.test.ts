/** issue_isometric through store.dispatch: undo removes the issue, redo restores the same one, a replay keeps it. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setSignaturePort } from '@core/commands/signaturePort';
import { useStore } from '@ui/store';
import { apply } from '../helpers/commandAssertions';
import { issueParams, permissivePort } from '../helpers/signedPlantDoc';
import { loadedL101 } from '../unit/plant/fabrication/isoM2Fixtures';

const state = (): ReturnType<typeof useStore.getState> => useStore.getState();
const issues = (): string[] => Object.keys(state().document.plant?.fabrication?.issues ?? {});

describe('issue_isometric through the store', () => {
  beforeEach(() => {
    setSignaturePort(permissivePort);
    state().setDocument(apply(loadedL101(), 'number_welds', { lineId: 'L-101' }));
    useStore.setState({ liveStatus: 'disconnected', localUndoStack: [], localRedoStack: [] });
  });
  afterEach(() => setSignaturePort(null));

  it('undo removes the issue, redo restores it, and a replay of the redone document still holds it', () => {
    state().dispatch('issue_isometric', { ...issueParams, confirmation: { nonce: 'n' } });
    const issued = issues();
    expect(issued).toHaveLength(1);
    state().undo();
    expect(issues()).toEqual([]);
    state().redo();
    expect(issues()).toEqual(issued);
    state().dispatch('replay_history', {});
    expect(issues()).toEqual(issued);
  });
});
