// 06 BLD review overlay: the toolbar toggle and the layer panel change no document; the overlay draws a group per selected solid from `blend_overlay`
// (contacts, junctions, corner patches coloured by status), the status line names the counts and the first failure, and a solid without a blend says so.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useBlendOverlayStore } from '@ui/store/blendOverlayStore';
import { BlendOverlay, MAX_BLEND_OVERLAYS } from '@ui/viewport/3d/overlays/BlendOverlay';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { junctionMarkers, lineSegments, parseBlendOverlay, statusLine } from '@ui/viewport/3d/overlays/blendOverlayGeometry';
import { runQuery } from '@ui/services/localQuery';
import { setGeometryKernel } from '@core/geometry/kernel';
import { CHAIN_FILLET, chainKernel } from '../helpers/profiledChainKernel';
import { dispatchEntity, resetViewportStores } from '../helpers/componentEntities';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

const ALL_ON = { contacts: true, junctions: true, corners: true, chamfers: true };

/** A filleted box whose edge 0 reads `edgeZeroAngle` rad between the normals (0.3 = a G1 failure) and whose other lines are tangent. */
function filletedBox(edgeZeroAngle = 0): string {
  setGeometryKernel(chainKernel((edge) => (edge === 0 ? edgeZeroAngle : 0)));
  const box = dispatchEntity('add_box', { size: [20, 10, 5] }).id;
  return dispatchEntity('fillet_edge', { id: box, ...CHAIN_FILLET }).id;
}

describe('ViewportControls - blend overlay toggle', () => {
  beforeEach(() => {
    resetViewportStores({ qualityOverride: 'auto' });
    useBlendOverlayStore.setState({ enabled: false, layers: ALL_ON });
  });
  afterEach(cleanup);

  it('the Blends button toggles the overlay and shows the layers and the legend, without changing the document', () => {
    render(<ViewportControls />);
    const before = JSON.stringify(useStore.getState().document);
    const button = screen.getByLabelText('Blend overlays');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Blend overlay layers')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(screen.getByLabelText('Blend overlay layers').id);
    expect(useBlendOverlayStore.getState().enabled).toBe(true);
    expect(Array.from(screen.getByLabelText('Blend status colours').querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      'pass',
      'warn',
      'fail',
      'not run',
      'corner: exact star',
      'corner: plate patch',
    ]);
    for (const [label, layer] of [
      ['Contacts', 'contacts'],
      ['Junctions', 'junctions'],
      ['Corner patches', 'corners'],
      ['Chamfer legs', 'chamfers'],
    ] as const) {
      fireEvent.click(screen.getByLabelText(label));
      expect(useBlendOverlayStore.getState().layers[layer]).toBe(false);
    }
    fireEvent.click(screen.getByLabelText('Blend overlays'));
    expect(useBlendOverlayStore.getState().enabled).toBe(false);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
  });
});

describe('blend overlay geometry from blend_overlay', () => {
  beforeEach(() => resetOfflineStore());
  afterEach(() => setGeometryKernel(null));

  it('a tangent chain: three pass lines of 10 points = 9 segments each, a junction marker of three axes, nothing in the other statuses', () => {
    const id = filletedBox();
    const view = parseBlendOverlay(runQuery('blend_overlay', { id, samples: 10 }).data);
    if (view === null) throw new Error('overlay expected');
    expect(view.counts).toEqual({ pass: 3, warn: 0, fail: 0, not_run: 0 });
    expect(lineSegments(view, 'contact', 'pass')).toHaveLength(2 * 9 * 6);
    expect(lineSegments(view, 'junction', 'pass')).toHaveLength(9 * 6);
    expect(junctionMarkers(view, 'pass')).toHaveLength(3 * 6);
    for (const status of ['warn', 'fail', 'not_run'] as const) {
      expect(lineSegments(view, 'contact', status)).toHaveLength(0);
      expect(junctionMarkers(view, status)).toHaveLength(0);
    }
    expect(statusLine(id, view)).toBe(`${id}: 3 pass, 0 warn, 0 fail, 0 not run`);
  });

  it('a failing contact moves to the fail status and the status line names the first failing finding', () => {
    const id = filletedBox(0.3);
    const view = parseBlendOverlay(runQuery('blend_overlay', { id }).data);
    if (view === null) throw new Error('overlay expected');
    expect(lineSegments(view, 'contact', 'fail').length).toBeGreaterThan(0);
    expect(lineSegments(view, 'contact', 'pass').length).toBeGreaterThan(0);
    const line = statusLine(id, view);
    expect(line).toContain('1 fail');
    expect(line).toContain('First failure:');
    expect(line).toContain('the normals differ by 0.3 rad along edge 0');
  });

  it('data that is not an answer is refused, damaged lines are left out, and a solid without a blend reads as such', () => {
    expect(parseBlendOverlay(null)).toBeNull();
    expect(parseBlendOverlay({ lines: [] })).toBeNull();
    const view = parseBlendOverlay({
      status: 'warn',
      lines: [
        {
          role: 'contact',
          edge: 1,
          profile: 'circular',
          status: 'warn',
          points: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
        { role: 'contact', edge: 2, profile: 'circular', status: 'maybe', points: [] },
        { role: 'nowhere', edge: 3, profile: 'x', status: 'pass', points: [] },
        null,
      ],
      counts: { warn: 1 },
    });
    expect(view?.lines).toHaveLength(1);
    expect(view?.counts.warn).toBe(1);
    const box = dispatchEntity('add_box', { size: [10, 10, 10] }).id;
    const bare = parseBlendOverlay(runQuery('blend_overlay', { id: box }).data);
    expect(bare && statusLine(box, bare)).toContain('no filleted or chamfered solid');
  });
});

describe('BlendOverlay', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetOfflineStore();
    useBlendOverlayStore.setState({ enabled: false, layers: ALL_ON, status: {} });
  });
  afterEach(() => {
    cleanup();
    setGeometryKernel(null);
    vi.restoreAllMocks();
  });

  it('draws nothing while off, a group per selected solid when on, and nothing once the selection is cleared', () => {
    const id = filletedBox();
    useStore.getState().select([id]);
    const { container } = render(<BlendOverlay />);
    expect(container.querySelector('group')).toBeNull();
    act(() => useBlendOverlayStore.getState().setEnabled(true));
    expect(container.querySelector(`group[name="blend-overlay-${id}"]`)).not.toBeNull();
    act(() => useStore.getState().select([]));
    expect(container.querySelector(`group[name="blend-overlay-${id}"]`)).toBeNull();
  });

  it('draws at most the first few selected solids', () => {
    const ids = Array.from({ length: MAX_BLEND_OVERLAYS + 2 }, () => dispatchEntity('add_box', { size: [10, 10, 10] }).id);
    useStore.getState().select(ids);
    useBlendOverlayStore.setState({ enabled: true });
    const { container } = render(<BlendOverlay />);
    expect(container.querySelectorAll('group[name^="blend-overlay-"]')).toHaveLength(MAX_BLEND_OVERLAYS);
  });

  it('each layer draws its own lines (two passes each) and disappears with its switch; the document is never changed', () => {
    const id = filletedBox(0.3);
    useStore.getState().select([id]);
    useBlendOverlayStore.setState({ enabled: true });
    const before = JSON.stringify(useStore.getState().document);
    const { container } = render(<BlendOverlay />);
    const lines = (): number => container.querySelectorAll('primitive').length;
    // contacts: one fail + one pass line, 2 passes each; junction: its line + its marker, 2 passes each
    expect(lines()).toBe(8);
    act(() => useBlendOverlayStore.getState().setLayer('junctions', false));
    expect(lines()).toBe(4);
    act(() => useBlendOverlayStore.getState().setLayer('contacts', false));
    expect(lines()).toBe(0);
    act(() => useBlendOverlayStore.getState().setLayer('junctions', true));
    expect(lines()).toBe(4);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
  });

  it('the status line (role status) names the counts and the first failure, says a bare solid has no blend, and goes with the selection', () => {
    const id = filletedBox(0.3);
    const bare = dispatchEntity('add_box', { size: [10, 10, 10] }).id;
    useStore.getState().select([id, bare]);
    useBlendOverlayStore.setState({ enabled: true });
    render(
      <>
        <BlendOverlay />
        <ViewportControls />
      </>,
    );
    const status = screen.getByRole('status', { name: 'Blend overlay status' });
    expect(status.textContent).toContain(`${id}: 2 pass, 0 warn, 1 fail, 0 not run. First failure:`);
    expect(status.textContent).toContain(`${bare}: no filleted or chamfered solid`);
    act(() => useStore.getState().select([]));
    expect(screen.queryByRole('status', { name: 'Blend overlay status' })).toBeNull();
  });

  it('without an exact kernel the status line says nothing could be read and no line is drawn', () => {
    const id = filletedBox();
    setGeometryKernel(null);
    useStore.getState().select([id]);
    useBlendOverlayStore.setState({ enabled: true });
    const { container } = render(
      <>
        <BlendOverlay />
        <ViewportControls />
      </>,
    );
    expect(container.querySelectorAll('primitive')).toHaveLength(0);
    expect(screen.getByRole('status', { name: 'Blend overlay status' }).textContent).toContain('no geometry kernel');
  });

  it('re-reads when the solid changes, not when something else in the document does (counted as kernel builds)', () => {
    const kernel = chainKernel(() => 0);
    setGeometryKernel(kernel);
    const box = dispatchEntity('add_box', { size: [20, 10, 5] }).id;
    const id = dispatchEntity('fillet_edge', { id: box, ...CHAIN_FILLET }).id;
    useStore.getState().select([id]);
    useBlendOverlayStore.setState({ enabled: true });
    render(<BlendOverlay />);
    const builds = kernel.recipes.length;
    act(() => {
      dispatchEntity('add_box', { size: [5, 5, 5] });
    });
    expect(kernel.recipes.length).toBe(builds);
    act(() => {
      useStore.setState((state) => ({
        document: {
          ...state.document,
          entities: { ...state.document.entities, [id]: { ...state.document.entities[id]!, name: 'renamed' } },
        },
      }));
    });
    expect(kernel.recipes.length).toBeGreaterThan(builds);
  });
});
