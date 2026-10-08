/**
 * Entities re-render discipline: a selection change must not re-render per-entity mesh branches
 * of entities whose own props did not change (R7 hot path).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';

const coneRenders = vi.hoisted(() => ({ byId: new Map<string, number>() }));

vi.mock('@ui/viewport/3d/entities/ConeMesh', () => ({
  ConeMesh: ({ entity }: { entity: { id: string } }): null => {
    coneRenders.byId.set(entity.id, (coneRenders.byId.get(entity.id) ?? 0) + 1);
    return null;
  },
}));
vi.mock('@ui/viewport/3d/InstancedRenderer', () => ({ InstancedRenderer: (): null => null }));
vi.mock('@ui/viewport/3d/GridAnnotations3D', () => ({ GridAnnotations3D: (): null => null }));

import { Entities } from '@ui/viewport/3d/Entities';

describe('Entities memoization', () => {
  beforeEach(() => {
    coneRenders.byId.clear();
    useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  });

  it('selecting one cone does not re-render an unrelated cone', () => {
    const first = localDispatch('add_cone', { radius: 1, height: 2 }).affected[0]!;
    const second = localDispatch('add_cone', { radius: 2, height: 3 }).affected[0]!;
    render(<Entities />);
    expect(coneRenders.byId.get(second)).toBe(1);

    act(() => useStore.getState().select([first]));

    expect(coneRenders.byId.get(first)).toBe(2);
    expect(coneRenders.byId.get(second)).toBe(1);
  });
});
