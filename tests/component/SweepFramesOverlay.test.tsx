import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { useStore } from '@ui/store';
import { SweepFramesOverlay } from '@ui/viewport/3d/analysis/SweepFramesOverlay';
import { loftSectionRings } from '@core/geometry/loft';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { useSurfaceOverlayStore } from '@ui/store/surfaceOverlayStore';
import { runQuery } from '@ui/services/localQuery';
import { axisLength, closedLoopSegments, frameSegments, parseFrameStations } from '@ui/viewport/3d/analysis/sweepFramesGeometry';
import { resetViewportStores } from '../helpers/componentEntities';
import { dispatchEntity } from '../helpers/componentEntities';
import { localDispatch, resetOfflineStore } from '../helpers/storeTestHelpers';
import { xyz } from '../helpers/xy';

describe('ViewportControls - frames overlay toggle', () => {
  beforeEach(() => {
    resetViewportStores({ qualityOverride: 'auto' });
    useSurfaceOverlayStore.setState({ frames: false });
  });

  it('the Frames button toggles the overlay and reports its state', () => {
    render(<ViewportControls />);
    const button = screen.getByLabelText('Sweep frames');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(useSurfaceOverlayStore.getState().frames).toBe(true);
    expect(screen.getByLabelText('Sweep frames').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByLabelText('Sweep frames'));
    expect(useSurfaceOverlayStore.getState().frames).toBe(false);
  });
});

describe('sweep frames geometry', () => {
  beforeEach(() => resetOfflineStore());

  it('maps the inspect_sweep answer of a real sweep to axis glyphs and section outlines', () => {
    const id = localDispatch('sweep_profile', { path: xyz(0, 0, 0, 0, 0, 100), radius: 10 }).affected[0] as string;
    const answer = runQuery('inspect_sweep', { id, samples: 5, outline: true });
    const stations = parseFrameStations(answer.data);
    expect(stations).toHaveLength(5);
    const segments = frameSegments(stations ?? []);
    expect(segments.tangent).toHaveLength(5 * 6);
    expect(segments.outlines.length).toBeGreaterThan(0);
    expect(segments.outlines.length % 6).toBe(0);
    // straight run along +Z: the tangent glyph of station k leaves the point along +Z, by the axis length
    const length = axisLength(stations ?? []);
    expect(length).toBeCloseTo(9, 3);
    expect(segments.tangent[2]).toBeCloseTo(0, 6);
    expect(segments.tangent[5]).toBeCloseTo(length, 4);
  });

  it('refuses data that is not an inspect_sweep answer', () => {
    expect(parseFrameStations(null)).toBeNull();
    expect(parseFrameStations({ samples: [] })).toBeNull();
    expect(parseFrameStations({ samples: [{ point: [0, 0, 0] }] })).toBeNull();
  });

  it('falls back to a twelfth of the span when there is no outline, and closes each loop', () => {
    const station = { point: [0, 0, 0], tangent: [0, 0, 1], normal: [1, 0, 0], binormal: [0, 1, 0], outline: null } as const;
    expect(axisLength([station, { ...station, point: [0, 0, 24] }])).toBe(2);
    expect(
      Array.from(
        closedLoopSegments([
          [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
        ]),
      ),
    ).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0]);
  });
});

describe('SweepFramesOverlay', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetOfflineStore();
    useSurfaceOverlayStore.setState({ frames: false });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('draws nothing while the toggle is off, a group per selected sweep or loft when on, and nothing once the selection is cleared', () => {
    const sweep = dispatchEntity('sweep_profile', { path: xyz(0, 0, 0, 0, 0, 40), radius: 4 }).id;
    const loft = dispatchEntity('loft_sections', {
      sections: [
        { center: [30, 0, 0], radius: 2 },
        { center: [30, 0, 6], radiusX: 3, radiusY: 1 },
      ],
    }).id;
    const box = dispatchEntity('add_box', { size: [1, 1, 1] }).id;
    useStore.getState().select([sweep, loft, box]);
    const { container } = render(<SweepFramesOverlay />);
    expect(container.querySelector('group')).toBeNull();
    act(() => useSurfaceOverlayStore.getState().setFrames(true));
    expect(container.querySelector('group[name="sweep-frames-' + sweep + '"]')).not.toBeNull();
    expect(container.querySelector('group[name="loft-sections-' + loft + '"]')).not.toBeNull();
    expect(
      container.querySelectorAll('group[name^="sweep-frames-"]:not([name="sweep-frames-overlay"]), group[name^="loft-sections-"]'),
    ).toHaveLength(2);
    act(() => useStore.getState().clearSelection());
    expect(container.querySelector('group[name^="sweep-frames-"]:not([name="sweep-frames-overlay"])')).toBeNull();
    expect(container.querySelector('group[name^="loft-sections-"]')).toBeNull();
    act(() => useSurfaceOverlayStore.getState().setFrames(false));
    expect(container.querySelector('group')).toBeNull();
  });

  it('draws at most the first 8 selected sweeps', () => {
    const ids = Array.from(
      { length: 10 },
      (_, k) => dispatchEntity('sweep_profile', { path: xyz(k * 20, 0, 0, k * 20, 0, 10), radius: 2 }).id,
    );
    useStore.getState().select(ids);
    useSurfaceOverlayStore.setState({ frames: true });
    const { container } = render(<SweepFramesOverlay />);
    expect(container.querySelectorAll('group[name^="sweep-frames-"]:not([name="sweep-frames-overlay"])')).toHaveLength(8);
  });
});

describe('loft section rings', () => {
  it('reads the rings as closed curves (denser than the ring points), and as polygons when every exact face is straight in u', () => {
    const ring: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ];
    expect(loftSectionRings({ rings: [ring] })[0]?.length).toBeGreaterThan(ring.length);
    const straight = { degreeU: 1 } as NonNullable<Parameters<typeof loftSectionRings>[0]['faces']>[number];
    expect(loftSectionRings({ rings: [ring], faces: [straight] })[0]).toEqual(ring);
  });
});
