// 01 DEF M4: the deformation review overlays. The toolbar toggle and the layer panel change no document; the overlay draws a group per selected deformed body
// from `deform_overlay`; the geometry helpers turn the command's answer into line segments (counted against the shape of the net, the slab, the grid).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useDeformOverlayStore } from '@ui/store/deformOverlayStore';
import { DeformOverlay, MAX_DEFORM_OVERLAYS } from '@ui/viewport/3d/overlays/DeformOverlay';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import {
  boxSegments,
  chainSegments,
  chainsSegments,
  frameSegments,
  gridSegments,
  netSegments,
  parseDeformOverlay,
  referenceFields,
  referenceParams,
  regionSegments,
} from '@ui/viewport/3d/overlays/deformOverlayGeometry';
import { runQuery } from '@ui/services/localQuery';
import { dispatchEntity, resetViewportStores } from '../helpers/componentEntities';
import { localDispatch, resetOfflineStore } from '../helpers/storeTestHelpers';

const FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;

function deformed(): string {
  const box = dispatchEntity('add_box', { size: [10, 10, 100], anchor: 'base-center' }).id;
  const twisted = localDispatch('twist_body', { id: box, angleDeg: 36, frame: FRAME, region: { start: 0, end: 20, infinite: true } });
  return twisted.affected[0] as string;
}

describe('ViewportControls - deformation overlay toggle', () => {
  beforeEach(() => {
    resetViewportStores({ qualityOverride: 'auto' });
    useDeformOverlayStore.setState({ enabled: false, reference: null });
  });
  afterEach(cleanup);

  it('the Deform button toggles the overlays and shows the layers, without changing the document', () => {
    render(<ViewportControls />);
    const before = JSON.stringify(useStore.getState().document);
    const button = screen.getByLabelText('Deformation overlays');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByLabelText('Deformation overlay layers')).toBeNull();
    fireEvent.click(button);
    expect(useDeformOverlayStore.getState().enabled).toBe(true);
    expect(screen.getByLabelText('Deformation overlay layers')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Lattice layer'));
    expect(useDeformOverlayStore.getState().layers.lattice).toBe(false);
    fireEvent.click(screen.getByLabelText('Lattice layer'));
    expect(useDeformOverlayStore.getState().layers.lattice).toBe(true);
    fireEvent.click(screen.getByLabelText('Deformation overlays'));
    expect(useDeformOverlayStore.getState().enabled).toBe(false);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
  });

  it('the reference shape: choosing a kind shows its fields, and the compareTo parameter exists only once every field is a number', () => {
    useDeformOverlayStore.setState({ enabled: true });
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Reference shape'), { target: { value: 'torus' } });
    for (const name of ['majorRadius', 'minorRadius', 'center', 'axis']) expect(screen.getByLabelText(`Reference ${name}`)).not.toBeNull();
    expect(screen.getByText('Fill every field to draw the shape.')).not.toBeNull();
    expect(referenceParams(useDeformOverlayStore.getState().reference)).toBeNull();
    const type = (name: string, value: string): void => {
      fireEvent.change(screen.getByLabelText(`Reference ${name}`), { target: { value } });
    };
    type('majorRadius', '60');
    type('minorRadius', '5');
    type('center', '0 0 0');
    type('axis', '0, 0, 1');
    expect(referenceParams(useDeformOverlayStore.getState().reference)).toEqual({
      kind: 'torus',
      majorRadius: 60,
      minorRadius: 5,
      center: [0, 0, 0],
      axis: [0, 0, 1],
    });
    expect(screen.queryByText('Fill every field to draw the shape.')).toBeNull();
    type('center', '0 0');
    expect(referenceParams(useDeformOverlayStore.getState().reference)).toBeNull();
    fireEvent.change(screen.getByLabelText('Reference shape'), { target: { value: '' } });
    expect(useDeformOverlayStore.getState().reference).toBeNull();
  });

  it('every reference kind lists its fields (a helicoid also its optional offset)', () => {
    expect(referenceFields('cone').map((f) => f.name)).toEqual(['apex', 'axis', 'halfAngleDeg']);
    expect(referenceFields('helicoid').map((f) => f.name)).toEqual(['point', 'axis', 'reference', 'rate', 'offset']);
    expect(referenceFields('nope')).toEqual([]);
    // a helicoid without the offset is complete (the offset defaults to 0)
    expect(referenceParams({ kind: 'helicoid', fields: { point: '0 0 0', axis: '0 0 1', reference: '1 0 0', rate: '0.05' } })).toEqual({
      kind: 'helicoid',
      point: [0, 0, 0],
      axis: [0, 0, 1],
      reference: [1, 0, 0],
      rate: 0.05,
    });
    expect(
      referenceParams({ kind: 'ellipticCylinder', fields: { point: '0 0 0', axis: '0 0 1', reference: '1 0 0', radii: '6 3' } }),
    ).toMatchObject({ radii: [6, 3] });
  });
});

describe('deformation overlay geometry from deform_overlay', () => {
  beforeEach(() => resetOfflineStore());

  it('an infinite twist region: three frame axes, the slab of two squares and four joining edges, and the axis extended past both ends', () => {
    const id = deformed();
    const view = parseDeformOverlay(runQuery('deform_overlay', { id }).data);
    expect(view).not.toBeNull();
    if (view === null || view.region === null) throw new Error('overlay expected');
    const axes = frameSegments(view.frame);
    for (const axis of [axes.x, axes.y, axes.z]) expect(axis).toHaveLength(6);
    expect(Array.from(axes.z.slice(0, 5))).toEqual([0, 0, 0, 0, 0]);
    expect(axes.z[5]).toBeCloseTo(view.frame.length, 4);
    const { slab, axis } = regionSegments(view.region, view.frame);
    expect(slab).toHaveLength(12 * 6);
    expect(axis).toHaveLength(6);
    // the axis runs from `radius` below the start plane to `radius` above the end plane along z
    expect(axis[2]).toBeCloseTo(-view.region.radius, 4);
    expect(axis[5]).toBeCloseTo(20 + view.region.radius, 4);
    expect(view.lattice).toBeNull();
    expect(view.flow).toBeNull();
    expect(view.sheet).toBeNull();
    expect(view.reference).toBeNull();
  });

  it('a finite region has no axis extension', () => {
    const box = dispatchEntity('add_box', { size: [10, 10, 100], anchor: 'base-center' }).id;
    const bent = localDispatch('twist_body', { id: box, angleDeg: 36, frame: FRAME, region: { start: 10, end: 60 } }).affected[0] as string;
    const view = parseDeformOverlay(runQuery('deform_overlay', { id: bent }).data);
    if (view === null || view.region === null) throw new Error('overlay expected');
    expect(view.region.infinite).toBe(false);
    expect(regionSegments(view.region, view.frame).axis).toHaveLength(0);
  });

  it('a lattice: the net lines at rest and displaced (one control point apart), the box edges', () => {
    const box = dispatchEntity('add_box', { size: [10, 10, 100], anchor: 'base-center' }).id;
    const made = localDispatch('deform_lattice', {
      id: box,
      degrees: [2, 2, 6],
      box: { min: [-5, -5, 0], max: [5, 5, 100] },
      splineDegrees: [2, 2, 2],
      frame: FRAME,
      moves: [{ index: [1, 1, 3], delta: [2, 0, 0] }],
    });
    const view = parseDeformOverlay(runQuery('deform_overlay', { id: made.affected[0] }).data);
    if (view === null || view.lattice === null) throw new Error('overlay expected');
    // lines along i: 2 x 3 x 7, along j: 3 x 2 x 7, along k: 3 x 3 x 6
    const rest = netSegments(view.lattice.rest, view.lattice.degrees);
    const moved = netSegments(view.lattice.moved, view.lattice.degrees);
    expect(rest).toHaveLength((42 + 42 + 54) * 6);
    expect(moved).toHaveLength(rest.length);
    expect(Array.from(moved).filter((v, i) => Math.abs(v - (rest[i] as number)) > 1e-12).length).toBeGreaterThan(0);
    expect(boxSegments(view.lattice.box)).toHaveLength(12 * 6);
    // a net of the wrong size or a box without 8 corners draws nothing
    expect(netSegments(view.lattice.rest.slice(1), view.lattice.degrees)).toHaveLength(0);
    expect(boxSegments(view.lattice.box.slice(1))).toHaveLength(0);
  });

  it('a flow onto a surface and its curves: chains and grids', () => {
    expect(
      chainSegments([
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ]),
    ).toHaveLength(12);
    expect(chainSegments([[0, 0, 0]])).toHaveLength(0);
    expect(
      chainsSegments([
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        [
          [0, 0, 0],
          [0, 1, 0],
          [0, 1, 1],
        ],
      ]),
    ).toHaveLength(18);
    // 3 x 2 nodes: 2 x 2 lines along i and 3 along j
    const nodes: Array<[number, number, number]> = [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
      [2, 1, 0],
    ];
    expect(gridSegments(nodes, 3, 2)).toHaveLength((4 + 3) * 6);
    expect(gridSegments(nodes, 2, 2)).toHaveLength(0);
  });

  it('a compareTo draws the reference wire; data that is not an overlay answer is refused', () => {
    const id = deformed();
    const view = parseDeformOverlay(runQuery('deform_overlay', { id, compareTo: { kind: 'sphere', center: [0, 0, 50], radius: 30 } }).data);
    expect(view?.reference).toHaveLength(3);
    expect(chainsSegments(view?.reference ?? []).length).toBeGreaterThan(300);
    expect(parseDeformOverlay(null)).toBeNull();
    expect(parseDeformOverlay({ frame: { origin: [0, 0, 0] } })).toBeNull();
    expect(parseDeformOverlay({ frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], length: 0 } })).toBeNull();
  });
});

describe('DeformOverlay', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetOfflineStore();
    useDeformOverlayStore.setState({ enabled: false, reference: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('draws nothing while off, a group per selected deformed body when on, never an undeformed one, and nothing once the selection is cleared', () => {
    const one = deformed();
    const plain = dispatchEntity('add_box', { size: [1, 1, 1] }).id;
    useStore.getState().select([one, plain]);
    const { container } = render(<DeformOverlay />);
    expect(container.querySelector('group')).toBeNull();
    act(() => useDeformOverlayStore.getState().setEnabled(true));
    expect(container.querySelector('group[name="deform-overlay-' + one + '"]')).not.toBeNull();
    expect(container.querySelector('group[name="deform-overlay-' + plain + '"]')).toBeNull();
    act(() => useStore.getState().clearSelection());
    expect(container.querySelector('group[name^="deform-overlay-"]')).toBeNull();
    act(() => useDeformOverlayStore.getState().setEnabled(false));
    expect(container.querySelector('group')).toBeNull();
  });

  it('draws at most the first four selected bodies and does not change the document', () => {
    const ids = Array.from({ length: MAX_DEFORM_OVERLAYS + 2 }, () => deformed());
    useStore.getState().select(ids);
    useDeformOverlayStore.setState({ enabled: true });
    const before = JSON.stringify(useStore.getState().document);
    const { container } = render(<DeformOverlay />);
    expect(container.querySelectorAll('group[name^="deform-overlay-"]:not([name="deform-overlay"])')).toHaveLength(MAX_DEFORM_OVERLAYS);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
  });
});
