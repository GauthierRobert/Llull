import { resetStore } from '../helpers/componentEntities';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '@ui/store';
import { entitiesFocus } from '@ui/panels/entityFocus';
import { localDispatch } from '../helpers/storeTestHelpers';

describe('entitiesFocus beacons', () => {
  beforeEach(() => resetStore());

  it('marks each of a handful of entities, the first carrying the pill', () => {
    const ids = [0, 50, 100].map((x) => localDispatch('add_box', { size: [10, 10, 10], position: [x, 0, 5] }).affected[0]!);
    const focus = entitiesFocus(useStore.getState().document, { key: 'k', label: 'three', ids });
    expect(focus.markers.map((marker) => marker.position[0])).toEqual([0, 50, 100]);
    expect(focus.markers[0]?.label).toBe('110 × 10 × 10 mm');
    expect(focus.markers[1]?.label).toBeUndefined();
  });

  it('marks a single entity once, at its centre', () => {
    const id = localDispatch('add_box', { size: [10, 10, 10], position: [7, 0, 5] }).affected[0]!;
    const focus = entitiesFocus(useStore.getState().document, { key: 'k', label: 'one', ids: [id], note: '502 g' });
    expect(focus.markers).toEqual([{ position: [7, 0, 5], label: '502 g' }]);
  });
});
