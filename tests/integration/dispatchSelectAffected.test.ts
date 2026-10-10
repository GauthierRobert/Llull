/**
 * dispatch(name, params, { selectAffected: true }) selects the command's affected ids — locally
 * (offline) and from the server response — and leaves the selection alone otherwise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { MAX_AUTO_SELECT } from '@ui/store/localMode';
import { flushPromises } from '../helpers/storeTestHelpers';

function stubServerAffecting(id: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          summary: 'ok',
          affected: [id],
          isError: false,
          canUndo: true,
          canRedo: false,
        }),
    }),
  );
}

describe('dispatch selectAffected', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected', localUndoStack: [], localRedoStack: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the created entity when running locally', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { selectAffected: true });
    const { document } = useStore.getState();
    expect(document.order).toHaveLength(1);
    expect(document.selection).toEqual(document.order);
  });

  it('does not auto-select a very large result (policy threshold), keeping the selection', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { selectAffected: true });
    const first = useStore.getState().document.order[0]!;
    useStore
      .getState()
      .dispatch(
        'array_linear',
        { id: first, count: MAX_AUTO_SELECT + 20, offset: [2, 0, 0] },
        { selectAffected: true },
      );
    const { document } = useStore.getState();
    expect(document.order.length).toBeGreaterThan(MAX_AUTO_SELECT);
    expect(document.selection).toEqual([first]);
  });

  it('still auto-selects a result right at the threshold', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { selectAffected: true });
    const first = useStore.getState().document.order[0]!;
    useStore
      .getState()
      .dispatch(
        'array_linear',
        { id: first, count: MAX_AUTO_SELECT + 1, offset: [2, 0, 0] },
        { selectAffected: true },
      );
    expect(useStore.getState().document.selection).toHaveLength(MAX_AUTO_SELECT);
  });

  it('keeps the selection without the option', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    expect(useStore.getState().document.selection).toEqual([]);
  });

  it('keeps the selection when the command fails (nothing affected)', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { selectAffected: true });
    const before = useStore.getState().document.selection;
    useStore.getState().dispatch('add_box', { size: [0, 1, 1] }, { selectAffected: true });
    expect(useStore.getState().document.selection).toEqual(before);
  });

  it('selects the affected ids from a server response', async () => {
    useStore.setState({ liveStatus: 'connected' });
    stubServerAffecting('box-9');
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { selectAffected: true });
    await flushPromises();
    expect(useStore.getState().document.selection).toEqual(['box-9']);
  });

  it('leaves the server-mode selection untouched without the option', async () => {
    useStore.setState({ liveStatus: 'connected' });
    stubServerAffecting('box-9');
    const before = useStore.getState().document;
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    await flushPromises();
    expect(useStore.getState().document).toBe(before);
  });

  it('keeps a selection the user changed while the request was in flight', async () => {
    useStore.setState({ liveStatus: 'connected' });
    stubServerAffecting('box-9');
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] }, { selectAffected: true });
    useStore.setState({ document: { ...useStore.getState().document, selection: ['other'] } });
    await flushPromises();
    expect(useStore.getState().document.selection).toEqual(['other']);
  });
});
