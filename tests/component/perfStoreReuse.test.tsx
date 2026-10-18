import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { reuseUnchanged } from '@ui/store/reuseUnchanged';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { liveSnapshot, localDispatch } from '../helpers/storeTestHelpers';

const reparse = (doc: CadDocument): CadDocument => JSON.parse(JSON.stringify(doc)) as CadDocument;

function twoBoxes(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
  return execute(doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] }).document;
}

describe('reuseUnchanged', () => {
  it('keeps previous references for equal content and adopts changed entities', () => {
    const previous = twoBoxes();
    const [first, second] = previous.order as [string, string];
    const next = reparse(previous);
    (next.entities[second] as { color: string }).color = '#123456';
    const merged = reuseUnchanged(previous, next);
    expect(merged.entities[first]).toBe(previous.entities[first]);
    expect(merged.entities[second]).not.toBe(previous.entities[second]);
    expect((merged.entities[second] as { color: string }).color).toBe('#123456');
    expect(merged.layers).toBe(previous.layers);
  });

  it('returns the previous entities record when nothing changed, and drops removed ids', () => {
    const previous = twoBoxes();
    expect(reuseUnchanged(previous, reparse(previous)).entities).toBe(previous.entities);
    const next = reparse(previous);
    const removed = next.order[0] as string;
    delete next.entities[removed];
    next.order = next.order.slice(1);
    const merged = reuseUnchanged(previous, next);
    expect(Object.keys(merged.entities)).toEqual(next.order);
    expect(merged.entities[next.order[0] as string]).toBe(previous.entities[next.order[0] as string]);
  });
});

describe('store snapshot adoption', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveSeq: -1, liveEpoch: null });
  });

  it('keeps identity of unchanged entities across a re-parsed snapshot (undo/redo, resync)', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    const before = useStore.getState().document;
    const [first, second] = before.order as [string, string];
    const snapshot = reparse(before);
    (snapshot.entities[second] as { color: string }).color = '#abcdef';
    useStore.getState().hydrateLiveDocument(liveSnapshot(snapshot, 10));
    const after = useStore.getState();
    expect(after.document.entities[first]).toBe(before.entities[first]);
    expect(after.document.entities[second]).not.toBe(before.entities[second]);
    expect(after.liveBase.entities[first]).toBe(before.entities[first]);
  });
});

describe('useDocumentWithoutSelection', () => {
  it('keeps identity on selection-only changes and changes with the document', () => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveSeq: -1, liveEpoch: null });
    localDispatch('add_box', { size: [1, 1, 1] });
    const id = useStore.getState().document.order[0] as string;
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDocumentWithoutSelection();
    });
    const initial = result.current;
    const rendersBefore = renders;
    act(() => useStore.getState().select([id]));
    expect(result.current).toBe(initial);
    expect(renders).toBe(rendersBefore);
    act(() => void localDispatch('add_box', { size: [3, 3, 3] }));
    expect(result.current).not.toBe(initial);
  });
});
