/**
 * Component tests for the Quality selector in ViewportControls (W5H).
 *
 * Asserts observable behavior:
 *   - The "Quality" label and select element render.
 *   - Changing the select updates qualityOverride in the viewportStore.
 *   - Default value is 'auto'.
 *   - All four options (Auto / High / Medium / Low) are present.
 *   - Store mutation via setQualityOverride is visible immediately.
 *
 * Does NOT assert three.js / r3f renderer internals — the canvas is not
 * instantiated in this test environment (jsdom has no WebGL).
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useViewportStore } from '@ui/store';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { __resetIdCounter } from '@lib/id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  useViewportStore.setState({
    displayMode: 'shaded',
    clipPlane: { enabled: false, axis: 'y', offset: 0, flipped: false },
    hiddenEntityIds: new Set(),
    qualityOverride: 'auto',
  });
}

// ---------------------------------------------------------------------------
// QualityControl rendering
// ---------------------------------------------------------------------------

describe('ViewportControls — Quality selector', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('renders a "Quality" label', () => {
    render(<ViewportControls />);
    expect(screen.getByText('Quality')).toBeDefined();
  });

  it('renders the quality select with accessible label "Render quality"', () => {
    render(<ViewportControls />);
    expect(screen.getByLabelText('Render quality')).toBeDefined();
  });

  it('defaults to "auto" value', () => {
    render(<ViewportControls />);
    const select = screen.getByLabelText('Render quality') as HTMLSelectElement;
    expect(select.value).toBe('auto');
  });

  it('has Auto, High, Medium, Low options', () => {
    render(<ViewportControls />);
    const select = screen.getByLabelText('Render quality') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('auto');
    expect(optionValues).toContain('high');
    expect(optionValues).toContain('medium');
    expect(optionValues).toContain('low');
  });

  it('changing to "high" updates qualityOverride in viewportStore', () => {
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Render quality'), {
      target: { value: 'high' },
    });
    expect(useViewportStore.getState().qualityOverride).toBe('high');
  });

  it('changing to "medium" updates qualityOverride in viewportStore', () => {
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Render quality'), {
      target: { value: 'medium' },
    });
    expect(useViewportStore.getState().qualityOverride).toBe('medium');
  });

  it('changing to "low" updates qualityOverride in viewportStore', () => {
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Render quality'), {
      target: { value: 'low' },
    });
    expect(useViewportStore.getState().qualityOverride).toBe('low');
  });

  it('changing back to "auto" restores auto mode', () => {
    useViewportStore.setState({ qualityOverride: 'high' });
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Render quality'), {
      target: { value: 'auto' },
    });
    expect(useViewportStore.getState().qualityOverride).toBe('auto');
  });

  it('select reflects a pre-set qualityOverride from the store', () => {
    useViewportStore.setState({ qualityOverride: 'low' });
    render(<ViewportControls />);
    const select = screen.getByLabelText('Render quality') as HTMLSelectElement;
    expect(select.value).toBe('low');
  });

  it('changing quality does NOT mutate CadDocument', () => {
    const docBefore = useStore.getState().document;
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Render quality'), {
      target: { value: 'low' },
    });
    // PRIME DIRECTIVE: no document mutation from a viewer preference change
    expect(useStore.getState().document).toBe(docBefore);
  });
});

// ---------------------------------------------------------------------------
// viewportStore — setQualityOverride action
// ---------------------------------------------------------------------------

describe('viewportStore — setQualityOverride action', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('starts as "auto"', () => {
    expect(useViewportStore.getState().qualityOverride).toBe('auto');
  });

  it('setQualityOverride("high") updates the store', () => {
    useViewportStore.getState().setQualityOverride('high');
    expect(useViewportStore.getState().qualityOverride).toBe('high');
  });

  it('setQualityOverride("low") updates the store', () => {
    useViewportStore.getState().setQualityOverride('low');
    expect(useViewportStore.getState().qualityOverride).toBe('low');
  });

  it('setQualityOverride("auto") returns to auto', () => {
    useViewportStore.getState().setQualityOverride('high');
    useViewportStore.getState().setQualityOverride('auto');
    expect(useViewportStore.getState().qualityOverride).toBe('auto');
  });
});
