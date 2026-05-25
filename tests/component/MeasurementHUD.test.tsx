/**
 * Component tests for <MeasurementHUD /> (M2 — measurement HUD overlay).
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - HUD is absent when lastMeasure is null.
 *   - Distance result renders value + unit.
 *   - Angle result renders degrees and radians.
 *   - Area result renders area + unit.
 *   - Perimeter result renders perimeter + unit.
 *   - Bounding-box result renders min / max / size.
 *   - Volume result renders volume + unit.
 *   - Mass-properties result renders volume, density, mass.
 *   - Dismiss button clears lastMeasure from the store.
 *
 * Does NOT test geometry math or r3f scene internals.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { MeasurementHUD } from '@ui/components/MeasurementHUD';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null, lastMeasure: null });
}

function setMeasure(command: string, data: unknown): void {
  useStore.setState({ lastMeasure: { command, data } });
}

// ---------------------------------------------------------------------------
// No measure — HUD is hidden
// ---------------------------------------------------------------------------

describe('MeasurementHUD — no measure', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders nothing when lastMeasure is null', () => {
    render(<MeasurementHUD />);
    expect(screen.queryByRole('region', { name: /measurement result/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// measure_distance
// ---------------------------------------------------------------------------

describe('MeasurementHUD — measure_distance', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders the title "Distance" in the HUD header', () => {
    setMeasure('measure_distance', { distance: 42.5, unit: 'mm' });
    render(<MeasurementHUD />);
    // Both the header title and the row label say "Distance" — use role query on the region.
    const region = screen.getByRole('region', { name: /measurement result: distance/i });
    expect(region).toBeDefined();
    expect(region.textContent).toContain('Distance');
  });

  it('renders the numeric distance value', () => {
    setMeasure('measure_distance', { distance: 42.5, unit: 'mm' });
    render(<MeasurementHUD />);
    // toFixed(3) → "42.500"
    expect(screen.getByText('42.500')).toBeDefined();
  });

  it('renders the unit label', () => {
    setMeasure('measure_distance', { distance: 42.5, unit: 'mm' });
    render(<MeasurementHUD />);
    expect(screen.getByText('mm')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// measure_angle
// ---------------------------------------------------------------------------

describe('MeasurementHUD — measure_angle', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders degrees with "deg" unit', () => {
    setMeasure('measure_angle', { degrees: 90, radians: Math.PI / 2 });
    render(<MeasurementHUD />);
    expect(screen.getByText('deg')).toBeDefined();
    expect(screen.getByText('90.0000')).toBeDefined();
  });

  it('renders radians with "rad" unit', () => {
    setMeasure('measure_angle', { degrees: 90, radians: Math.PI / 2 });
    render(<MeasurementHUD />);
    expect(screen.getByText('rad')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// measure_area
// ---------------------------------------------------------------------------

describe('MeasurementHUD — measure_area', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders area value and unit', () => {
    setMeasure('measure_area', { area: 100, unit: 'mm²' });
    render(<MeasurementHUD />);
    expect(screen.getByText('100.000')).toBeDefined();
    expect(screen.getByText('mm²')).toBeDefined();
  });

  it('renders "Area" in the HUD header', () => {
    setMeasure('measure_area', { area: 100, unit: 'mm²' });
    render(<MeasurementHUD />);
    const region = screen.getByRole('region', { name: /measurement result: area/i });
    expect(region).toBeDefined();
    expect(region.textContent).toContain('Area');
  });
});

// ---------------------------------------------------------------------------
// measure_perimeter
// ---------------------------------------------------------------------------

describe('MeasurementHUD — measure_perimeter', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders perimeter value and unit', () => {
    setMeasure('measure_perimeter', { perimeter: 40, unit: 'mm' });
    render(<MeasurementHUD />);
    expect(screen.getByText('40.000')).toBeDefined();
  });

  it('renders "Perimeter" in the HUD header', () => {
    setMeasure('measure_perimeter', { perimeter: 40, unit: 'mm' });
    render(<MeasurementHUD />);
    const region = screen.getByRole('region', { name: /measurement result: perimeter/i });
    expect(region).toBeDefined();
    expect(region.textContent).toContain('Perimeter');
  });
});

// ---------------------------------------------------------------------------
// measure_bounding_box
// ---------------------------------------------------------------------------

describe('MeasurementHUD — measure_bounding_box', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  const bboxData = {
    min: [-1, -2, -3] as [number, number, number],
    max: [4, 5, 6] as [number, number, number],
    size: [5, 7, 9] as [number, number, number],
  };

  it('renders the "Bounding Box" title', () => {
    setMeasure('measure_bounding_box', bboxData);
    render(<MeasurementHUD />);
    expect(screen.getByText('Bounding Box')).toBeDefined();
  });

  it('renders the min corner', () => {
    setMeasure('measure_bounding_box', bboxData);
    render(<MeasurementHUD />);
    // min row value: "(-1.000, -2.000, -3.000)"
    expect(screen.getByText('(-1.000, -2.000, -3.000)')).toBeDefined();
  });

  it('renders the max corner', () => {
    setMeasure('measure_bounding_box', bboxData);
    render(<MeasurementHUD />);
    expect(screen.getByText('(4.000, 5.000, 6.000)')).toBeDefined();
  });

  it('renders the size', () => {
    setMeasure('measure_bounding_box', bboxData);
    render(<MeasurementHUD />);
    expect(screen.getByText('(5.000, 7.000, 9.000)')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// measure_volume
// ---------------------------------------------------------------------------

describe('MeasurementHUD — measure_volume', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders volume value and unit', () => {
    setMeasure('measure_volume', { volume: 8, unit: 'mm³' });
    render(<MeasurementHUD />);
    expect(screen.getByText('8.000')).toBeDefined();
    expect(screen.getByText('mm³')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mass_properties
// ---------------------------------------------------------------------------

describe('MeasurementHUD — mass_properties', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders mass value and "g" unit', () => {
    setMeasure('mass_properties', { volume: 8, density: 0.00785, mass: 0.0628, unit: 'g' });
    render(<MeasurementHUD />);
    expect(screen.getByText('Mass Properties')).toBeDefined();
    // mass value: "0.063"
    expect(screen.getByText('0.063')).toBeDefined();
  });

  it('renders volume and density rows', () => {
    setMeasure('mass_properties', { volume: 8, density: 0.00785, mass: 0.0628, unit: 'g' });
    render(<MeasurementHUD />);
    // Both "Volume" and "Density" labels must appear
    const rows = screen.getAllByText(/volume|density/i);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Dismiss button
// ---------------------------------------------------------------------------

describe('MeasurementHUD — dismiss', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('clicking dismiss clears lastMeasure in the store', () => {
    setMeasure('measure_distance', { distance: 10, unit: 'mm' });
    render(<MeasurementHUD />);

    const btn = screen.getByRole('button', { name: /dismiss measurement/i });
    fireEvent.click(btn);

    expect(useStore.getState().lastMeasure).toBeNull();
  });

  it('HUD disappears after dismiss', () => {
    setMeasure('measure_distance', { distance: 10, unit: 'mm' });
    const { rerender } = render(<MeasurementHUD />);

    fireEvent.click(screen.getByRole('button', { name: /dismiss measurement/i }));

    // Force re-render to reflect store change
    rerender(<MeasurementHUD />);
    expect(screen.queryByRole('region', { name: /measurement result/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Store integration — dispatch sets lastMeasure
// ---------------------------------------------------------------------------

describe('MeasurementHUD — store dispatch integration', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('lastMeasure is null before any measure command', () => {
    expect(useStore.getState().lastMeasure).toBeNull();
  });

  it('dispatching a mutating command does not set lastMeasure', () => {
    useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
    expect(useStore.getState().lastMeasure).toBeNull();
  });

  it('dispatching measure_distance sets lastMeasure with correct shape', () => {
    // add two entities so measure_distance has something to work with via points
    const result = useStore.getState().dispatch('measure_distance', {
      point1: [0, 0, 0],
      point2: [3, 4, 0],
    });
    // Should return data with distance = 5
    expect(result.data).toBeDefined();
    const measure = useStore.getState().lastMeasure;
    expect(measure).not.toBeNull();
    expect(measure?.command).toBe('measure_distance');
    expect((measure?.data as { distance: number }).distance).toBeCloseTo(5, 3);
  });

  it('clearLastMeasure sets lastMeasure to null', () => {
    useStore.setState({ lastMeasure: { command: 'measure_distance', data: { distance: 5, unit: 'mm' } } });
    useStore.getState().clearLastMeasure();
    expect(useStore.getState().lastMeasure).toBeNull();
  });
});
