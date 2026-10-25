/** VC-VIS-13: review data written by metaHistory commands is undoable and redoable through the store, with the same ids on redo. */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';

const state = (): ReturnType<typeof useStore.getState> => useStore.getState();

describe('review commands through store.dispatch', () => {
  beforeEach(() => {
    state().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
  });

  it('undo removes a viewpoint, an issue and its status change; redo restores them with the same ids', () => {
    state().dispatch('save_viewpoint', { name: 'v', fromDocumentCamera: true });
    state().dispatch('create_review_issue', { title: 'gap', viewpointIds: ['vp-1'] });
    state().dispatch('set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'fixed' });
    const reviewed = state().document.review;
    expect(reviewed?.issues['iss-2']?.status).toBe('resolved');
    state().undo();
    expect(state().document.review?.issues['iss-2']?.status).toBe('open');
    state().undo();
    state().undo();
    expect(state().document.review).toBeUndefined();
    state().redo();
    state().redo();
    state().redo();
    expect(state().document.review).toEqual(reviewed);
  });

  it('an agent closing an issue through dispatch is refused and leaves no history step', () => {
    state().dispatch('create_review_issue', { title: 'gap' });
    const before = state().document;
    state().dispatch('set_issue_status', { issueId: 'iss-1', status: 'closed', reason: 'accept' });
    expect(state().document.review).toEqual(before.review);
    expect(state().document.review?.issues['iss-1']?.status).toBe('open');
  });
});
