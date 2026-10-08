/**
 * A finished gizmo drag becomes exactly one transform command (or nothing). Dispatching it moves
 * the entity through the normal command layer; a drag that snaps back to its start dispatches
 * nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { gizmoDragCommit, type GizmoTransform } from '@ui/viewport/3d/gizmoCommit';
import { localDispatch } from '../helpers/storeTestHelpers';

const rest: GizmoTransform = {
  position: { x: 0, y: 0, z: 1 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};
const moved = (patch: Partial<GizmoTransform>): GizmoTransform => ({ ...rest, ...patch });

describe('gizmoDragCommit', () => {
  it('translate: a moved target becomes move_entity with the delta', () => {
    const commit = gizmoDragCommit(
      'translate',
      'box-1.1',
      rest,
      moved({ position: { x: 0.5, y: 0, z: 1 } }),
    );
    expect(commit).toEqual({ name: 'move_entity', params: { id: 'box-1.1', delta: [0.5, 0, 0] } });
  });

  it('translate: a drag that ends where it began (e.g. snapped back to the grid) commits nothing', () => {
    expect(gizmoDragCommit('translate', 'box-1.1', rest, moved({}))).toBeNull();
  });

  it('rotate: becomes rotate_entity with the Euler delta in radians', () => {
    const commit = gizmoDragCommit(
      'rotate',
      'box-1.1',
      rest,
      moved({ rotation: { x: 0, y: 0, z: Math.PI / 2 } }),
    );
    expect(commit).toEqual({
      name: 'rotate_entity',
      params: { id: 'box-1.1', delta: [0, 0, Math.PI / 2] },
    });
  });

  it('scale: becomes scale_entity with the factor relative to the start, ignoring no-ops', () => {
    expect(gizmoDragCommit('scale', 'b', rest, moved({ scale: { x: 2, y: 2, z: 2 } }))).toEqual({
      name: 'scale_entity',
      params: { id: 'b', factor: 2 },
    });
    expect(gizmoDragCommit('scale', 'b', rest, moved({}))).toBeNull();
    expect(gizmoDragCommit('scale', 'b', rest, moved({ scale: { x: 0, y: 0, z: 0 } }))).toBeNull();
  });
});

describe('gizmo commit through the command layer', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
  });

  it('dispatching the commit moves the entity', () => {
    const id = localDispatch('add_box', { size: [2, 2, 2] }).affected[0]!;
    const commit = gizmoDragCommit(
      'translate',
      id,
      rest,
      moved({ position: { x: 3, y: 0, z: 1 } }),
    )!;
    useStore.getState().dispatch(commit.name, commit.params);
    expect(useStore.getState().document.entities[id]?.position[0]).toBeCloseTo(3);
  });
});
