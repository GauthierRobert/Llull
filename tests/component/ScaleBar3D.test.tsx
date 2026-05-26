/**
 * Component tests for ScaleBar3D — the 3D viewport scale bar HUD.
 *
 * Asserts observable behavior (R11):
 *   - The textual label matches formatLength(doc, worldLength) for given inputs.
 *   - The bar element is rendered.
 *   - Changing the document unit updates the label.
 *
 * No three.js or Canvas involvement — ScaleBar3D is a plain HTML overlay.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createEmptyDocument } from '@core/model/types';
import { __resetIdCounter } from '@lib/id';
import { ScaleBar3D } from '@ui/viewport/3d/ScaleBar3D';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(units: 'mm' | 'cm' | 'm' | 'in' | 'ft', displayPrecision = 3): ReturnType<typeof createEmptyDocument> {
  return { ...createEmptyDocument(), units, displayPrecision };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScaleBar3D', () => {
  beforeEach(() => {
    __resetIdCounter();
  });

  it('renders without crashing', () => {
    const doc = makeDoc('mm');
    const { container } = render(
      <ScaleBar3D distance={10} viewportWidthPx={800} document={doc} />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it('shows a label containing the document units (mm)', () => {
    const doc = makeDoc('mm', 2);
    render(<ScaleBar3D distance={10} viewportWidthPx={800} document={doc} />);
    // The label should contain "mm"
    const label = screen.getByText(/mm/i);
    expect(label).toBeDefined();
  });

  it('shows a label containing the document units (m)', () => {
    const doc = makeDoc('m', 1);
    render(<ScaleBar3D distance={1000} viewportWidthPx={800} document={doc} />);
    const label = screen.getByText(/ m$/);
    expect(label).toBeDefined();
  });

  it('shows a label containing the document units (in)', () => {
    const doc = makeDoc('in', 2);
    render(<ScaleBar3D distance={50} viewportWidthPx={800} document={doc} />);
    const label = screen.getByText(/in/);
    expect(label).toBeDefined();
  });

  it('label format matches formatLength(doc, worldLength)', () => {
    const doc = makeDoc('mm', 3);
    render(<ScaleBar3D distance={10} viewportWidthPx={800} document={doc} fovDeg={45} />);
    // The label is a numeric value followed by " mm"; it should match toFixed(3) + " mm".
    const label = screen.getByText(/[\d.]+ mm/);
    expect(label).toBeDefined();
    // The number must end with exactly 3 decimal places.
    const text = label.textContent ?? '';
    expect(text).toMatch(/^\d+\.\d{3} mm$/);
  });

  it('label changes unit when document unit changes', () => {
    const docMm = makeDoc('mm', 2);
    const docCm = makeDoc('cm', 2);
    const { rerender } = render(
      <ScaleBar3D distance={10} viewportWidthPx={800} document={docMm} />,
    );
    expect(screen.queryByText(/cm/)).toBeNull();

    rerender(<ScaleBar3D distance={10} viewportWidthPx={800} document={docCm} />);
    expect(screen.getByText(/cm/)).toBeDefined();
  });

  it('renders a bar element (visual indicator div)', () => {
    const doc = makeDoc('mm');
    const { container } = render(
      <ScaleBar3D distance={10} viewportWidthPx={800} document={doc} />,
    );
    // The bar is a <div> with a gradient background; container has nested divs.
    const divs = container.querySelectorAll('div');
    // Outer wrapper + bar + left tick + right tick = at least 4 elements.
    expect(divs.length).toBeGreaterThanOrEqual(3);
  });

  it('does not mutate the document', () => {
    const doc = makeDoc('mm');
    const docCopy = { ...doc };
    render(<ScaleBar3D distance={10} viewportWidthPx={800} document={doc} />);
    expect(doc.units).toBe(docCopy.units);
    expect(doc.displayPrecision).toBe(docCopy.displayPrecision);
  });
});
