// 03 WRP review overlays: the toolbar toggle and the layer panel change no document; the overlay draws a group per selected solid from `wrap_overlay`
// (curves on faces, edges by convexity); the geometry helpers turn the answer into line segments (counted against the polylines).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useWrapOverlayStore } from '@ui/store/wrapOverlayStore';
import { MAX_WRAP_OVERLAYS, WrapOverlay } from '@ui/viewport/3d/overlays/WrapOverlay';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { curveSegments, edgeSegments, parseWrapOverlay } from '@ui/viewport/3d/overlays/wrapOverlayGeometry';
import { runQuery } from '@ui/services/localQuery';
import { setGeometryKernel } from '@core/geometry/kernel';
import { newEntity } from '@core/commands/entity/newEntity';
import { fakeSplitKernel } from '../helpers/fakeSplitKernel';
import { dispatchEntity, resetViewportStores } from '../helpers/componentEntities';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

describe('ViewportControls - wrap overlay toggle', () => {
  beforeEach(() => {
    resetViewportStores({ qualityOverride: 'auto' });
    useWrapOverlayStore.setState({ enabled: false, layers: { curves: true, edges: true } });
  });
  afterEach(cleanup);

  it('the Wrap button toggles the overlays and shows the layers and the legend, without changing the document', () => {
    render(<ViewportControls />);
    const before = JSON.stringify(useStore.getState().document);
    const button = screen.getByLabelText('Wrap overlays');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Wrap overlay layers')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(screen.getByLabelText('Wrap overlay layers').id);
    expect(useWrapOverlayStore.getState().enabled).toBe(true);
    expect(screen.getByLabelText('Face join colours').querySelectorAll('li')).toHaveLength(4);
    fireEvent.click(screen.getByLabelText('Face joins'));
    expect(useWrapOverlayStore.getState().layers.edges).toBe(false);
    expect(screen.queryByLabelText('Face join colours')).toBeNull();
    fireEvent.click(screen.getByLabelText('Curves on faces'));
    expect(useWrapOverlayStore.getState().layers.curves).toBe(false);
    fireEvent.click(screen.getByLabelText('Wrap overlays'));
    expect(useWrapOverlayStore.getState().enabled).toBe(false);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
  });
});

describe('wrap overlay geometry from wrap_overlay', () => {
  beforeEach(() => {
    resetOfflineStore();
    setGeometryKernel(fakeSplitKernel({ corner: { convexity: 'convex' } }));
  });
  afterEach(() => setGeometryKernel(null));

  it('the edges of a solid with a sharp edge: one convex polyline of 24 points = 23 segments, none of the other convexities', () => {
    const id = dispatchEntity('add_box', { size: [60, 40, 10] }).id;
    const view = parseWrapOverlay(runQuery('wrap_overlay', { id }).data);
    expect(view).not.toBeNull();
    if (view === null) throw new Error('overlay expected');
    expect(view.edges).toHaveLength(1);
    expect(edgeSegments(view, 'convex')).toHaveLength(23 * 6);
    for (const other of ['smooth', 'concave', 'unknown'] as const) expect(edgeSegments(view, other)).toHaveLength(0);
    expect(curveSegments(view, 'solid')).toHaveLength(0);
  });

  it('data that is not an answer is refused and damaged entries are left out', () => {
    expect(parseWrapOverlay(null)).toBeNull();
    expect(parseWrapOverlay({})).toBeNull();
    const view = parseWrapOverlay({
      curves: [
        {
          id: 'c',
          face: 0,
          source: 'solid',
          points: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
        },
        { id: 'bad', face: 0, source: 'nowhere', points: [] },
        null,
      ],
      edges: [
        { edge: 0, faces: [0, 1], convexity: 'weird', points: [] },
        {
          edge: 1,
          faces: [0, 1],
          convexity: 'smooth',
          points: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
      ],
    });
    expect(view?.curves).toHaveLength(1);
    expect(curveSegments(view as NonNullable<typeof view>, 'solid')).toHaveLength(2 * 6);
    expect(view?.edges).toHaveLength(1);
    expect(parseWrapOverlay({ curves: [], edges: null })?.edges).toBeNull();
  });
});

describe('WrapOverlay', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetOfflineStore();
    setGeometryKernel(fakeSplitKernel({ corner: { convexity: 'convex' } }));
    useWrapOverlayStore.setState({ enabled: false, layers: { curves: true, edges: true } });
  });
  afterEach(() => {
    cleanup();
    setGeometryKernel(null);
    vi.restoreAllMocks();
  });

  it('draws nothing while off, a group per selected solid when on, and nothing once the selection is cleared', () => {
    const one = dispatchEntity('add_box', { size: [60, 40, 10] }).id;
    useStore.getState().select([one]);
    const { container } = render(<WrapOverlay />);
    expect(container.querySelector('group')).toBeNull();
    act(() => useWrapOverlayStore.getState().setEnabled(true));
    expect(container.querySelector(`group[name="wrap-overlay-${one}"]`)).not.toBeNull();
    act(() => useStore.getState().select([]));
    expect(container.querySelector(`group[name="wrap-overlay-${one}"]`)).toBeNull();
  });

  it('draws at most the first few selected solids', () => {
    const ids = Array.from({ length: MAX_WRAP_OVERLAYS + 2 }, () => dispatchEntity('add_box', { size: [10, 10, 10] }).id);
    useStore.getState().select(ids);
    useWrapOverlayStore.setState({ enabled: true });
    const { container } = render(<WrapOverlay />);
    expect(container.querySelectorAll('group[name^="wrap-overlay-"]')).toHaveLength(MAX_WRAP_OVERLAYS);
  });

  it('each layer draws its own lines: the primitives of the curves and of the edges disappear with their switch, and the popover says what is missing', () => {
    const solid = dispatchEntity('add_box', { size: [60, 40, 10] }).id;
    useStore.setState((state) => ({
      document: {
        ...state.document,
        entities: {
          ...state.document.entities,
          'curve-9.1': newEntity(
            'nurbs_curve',
            'curve-9.1',
            {
              curve: {
                degree: 1,
                poles: [
                  [0, 0, 0],
                  [10, 0, 0],
                ],
                knots: [0, 1],
                multiplicities: [2, 2],
              },
              onFace: {
                entityId: solid,
                faceIndex: 0,
                pcurve: {
                  degree: 1,
                  poles: [
                    [0, 0],
                    [1, 0],
                  ],
                  knots: [0, 1],
                  multiplicities: [2, 2],
                },
                frame: 'native' as const,
                fitTolerance: 1e-6,
                chartLength: 10,
              },
            },
            [0, 0, 0],
            '#ffffff',
          ),
        },
      },
    }));
    useStore.getState().select([solid]);
    useWrapOverlayStore.setState({ enabled: true });
    const { container } = render(
      <>
        <WrapOverlay />
        <ViewportControls />
      </>,
    );
    const lines = (): number => container.querySelectorAll('primitive').length;
    // one polyline of the curve and one convex edge, each drawn in two passes
    expect(lines()).toBe(4);
    act(() => useWrapOverlayStore.getState().setLayer('edges', false));
    expect(lines()).toBe(2);
    act(() => useWrapOverlayStore.getState().setLayer('curves', false));
    expect(lines()).toBe(0);
    act(() => useWrapOverlayStore.getState().setLayer('edges', true));
    expect(lines()).toBe(2);
    // without an exact kernel the edges are not there and the popover says so
    act(() => setGeometryKernel(null));
    act(() => useStore.getState().select([]));
    act(() => useStore.getState().select([solid]));
    expect(lines()).toBe(0);
    act(() => useWrapOverlayStore.getState().setLayer('curves', true));
    expect(lines()).toBe(2);
    expect(screen.getByRole('status', { name: 'Wrap overlay status' }).textContent).toContain('no exact kernel');
    act(() => useStore.getState().select([]));
    expect(screen.queryByRole('status', { name: 'Wrap overlay status' })).toBeNull();
  });
});
