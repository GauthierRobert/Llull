import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { runQuery } from '@ui/services/localQuery';

describe('runQuery', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
    useStore.getState().dispatch('add_box', { size: [2, 3, 4] });
  });

  it('runs a read-only command on the store document', () => {
    const result = runQuery('measure_bounding_box');
    expect(result.data).toBeDefined();
    expect(result.document).toBe(useStore.getState().document);
  });

  it('refuses a mutating command without running it', () => {
    const before = useStore.getState().document;
    const result = runQuery('add_box', { size: [1, 1, 1] });
    expect(result.summary).toMatch(/run it through dispatch/);
    expect(result.document).toBe(before);
    expect(result.affected).toEqual([]);
  });
});
