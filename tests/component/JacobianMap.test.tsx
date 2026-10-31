// 01 DEF M4: the Jacobian colour map of a deformed body. The "Det J" layer is off by default and queries nothing; when on, the selected deformed body gets a
// vertex-coloured mesh from `deform_jacobian_map` and the legend reports its range and folded vertices. Presentation only: no command changes the document.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useDeformOverlayStore } from '@ui/store/deformOverlayStore';
import { DeformOverlay } from '@ui/viewport/3d/overlays/DeformOverlay';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { dispatchEntity, resetViewportStores } from '../helpers/componentEntities';
import { localDispatch, resetOfflineStore } from '../helpers/storeTestHelpers';

const FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;

function stretched(): string {
  const box = dispatchEntity('add_box', { size: [10, 10, 100], anchor: 'base-center' }).id;
  return localDispatch('stretch_body', { id: box, factor: 2, frame: FRAME }).affected[0] as string;
}

describe('Jacobian map layer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetOfflineStore();
    resetViewportStores({ qualityOverride: 'auto' });
    useDeformOverlayStore.setState({ enabled: true, reference: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('is off by default: the body gets no map and nothing is reported', () => {
    const id = stretched();
    useStore.getState().select([id]);
    const { container } = render(<DeformOverlay />);
    expect(useDeformOverlayStore.getState().layers.jacobian).toBe(false);
    expect(container.querySelector('mesh[name^="jacobian-map-"]')).toBeNull();
    expect(useDeformOverlayStore.getState().jacobian).toEqual({});
  });

  it('draws a coloured mesh on the selected deformed body only, and reports its range; switching the layer off removes both', () => {
    const id = stretched();
    const plain = dispatchEntity('add_box', { size: [1, 1, 1] }).id;
    useStore.getState().select([id, plain]);
    const before = JSON.stringify(useStore.getState().document);
    const { container } = render(<DeformOverlay />);
    act(() => useDeformOverlayStore.getState().setLayer('jacobian', true));
    expect(container.querySelector(`mesh[name="jacobian-map-${id}"]`)).not.toBeNull();
    expect(container.querySelector(`mesh[name="jacobian-map-${plain}"]`)).toBeNull();
    const stats = useDeformOverlayStore.getState().jacobian[id];
    expect(stats).toMatchObject({ folded: 0 });
    expect(stats !== undefined && 'max' in stats ? stats.max : null).toBeCloseTo(2, 6);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
    act(() => useDeformOverlayStore.getState().setLayer('jacobian', false));
    expect(container.querySelector('mesh[name^="jacobian-map-"]')).toBeNull();
    expect(useDeformOverlayStore.getState().jacobian).toEqual({});
  });

  it('a refused map reports why instead of drawing: the legend shows the refusal', () => {
    const box = dispatchEntity('add_box', { size: [10, 10, 100], anchor: 'base-center' }).id;
    const id = localDispatch('bend_body', { id: box, radius: 400, angleDeg: 14, frame: FRAME }).affected[0] as string;
    const { document } = useStore.getState();
    const entity = document.entities[id];
    const recipe = entity?.kind === 'mesh' ? entity.brep : undefined;
    if (entity?.kind !== 'mesh' || recipe?.op !== 'deform') throw new Error('deform node expected');
    // a recipe whose refinement cannot be built (a tolerance whose refinement exceeds the budget)
    const refined = { ...entity, brep: { ...recipe, output: { ...recipe.output, tolerance: 1e-9 } } };
    useStore.setState({ document: { ...document, entities: { ...document.entities, [id]: refined } } });
    useStore.getState().select([id]);
    const { container } = render(
      <>
        <DeformOverlay />
        <ViewportControls />
      </>,
    );
    act(() => useDeformOverlayStore.getState().setLayer('jacobian', true));
    expect(container.querySelector('mesh[name^="jacobian-map-"]')).toBeNull();
    expect(useDeformOverlayStore.getState().jacobian[id]).toHaveProperty('failure');
    expect(screen.getByLabelText('Jacobian map').textContent).toContain('DEF_');
  });

  it('the Det J checkbox switches the layer and shows the scale', () => {
    render(<ViewportControls />);
    expect(screen.queryByLabelText('Jacobian map')).toBeNull();
    fireEvent.click(screen.getByLabelText('Det J'));
    expect(useDeformOverlayStore.getState().layers.jacobian).toBe(true);
    expect(screen.getByLabelText('Jacobian map').textContent).toContain('magenta = folded');
  });
});
