/**
 * Component / store tests for EN8 — 3D viewport enrichments.
 *
 * Covers:
 *   1. viewportStore actions: setDisplayMode, setClipPlane, toggleClipPlane,
 *      toggleEntityVisibility, showAllEntities.
 *   2. ViewportControls component: display-mode buttons switch the store value,
 *      section-plane toggle shows/hides the expanded controls.
 *   3. PropertiesPanel: Hide/Show button calls toggleEntityVisibility in the store.
 *
 * Asserts observable behavior (R11) — store state changes, button presence,
 * aria-pressed values. Does NOT assert three.js renderer internals.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useViewportStore } from '@ui/store';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { __resetIdCounter } from '@lib/id';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  useViewportStore.setState({
    displayMode: 'shaded',
    clipPlane: { enabled: false, axis: 'y', offset: 0, flipped: false },
    hiddenEntityIds: new Set(),
  });
}

// ---------------------------------------------------------------------------
// Store unit tests — viewportStore actions
// ---------------------------------------------------------------------------

describe('viewportStore — displayMode', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('starts as "shaded"', () => {
    expect(useViewportStore.getState().displayMode).toBe('shaded');
  });

  it('setDisplayMode("wireframe") updates the store', () => {
    useViewportStore.getState().setDisplayMode('wireframe');
    expect(useViewportStore.getState().displayMode).toBe('wireframe');
  });

  it('setDisplayMode("xray") updates the store', () => {
    useViewportStore.getState().setDisplayMode('xray');
    expect(useViewportStore.getState().displayMode).toBe('xray');
  });

  it('setDisplayMode("shaded") returns to shaded', () => {
    useViewportStore.getState().setDisplayMode('wireframe');
    useViewportStore.getState().setDisplayMode('shaded');
    expect(useViewportStore.getState().displayMode).toBe('shaded');
  });
});

describe('viewportStore — clipPlane', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('starts with clip plane disabled', () => {
    expect(useViewportStore.getState().clipPlane.enabled).toBe(false);
  });

  it('toggleClipPlane enables the clip plane', () => {
    useViewportStore.getState().toggleClipPlane();
    expect(useViewportStore.getState().clipPlane.enabled).toBe(true);
  });

  it('toggleClipPlane twice returns to disabled', () => {
    useViewportStore.getState().toggleClipPlane();
    useViewportStore.getState().toggleClipPlane();
    expect(useViewportStore.getState().clipPlane.enabled).toBe(false);
  });

  it('setClipPlane updates axis', () => {
    useViewportStore.getState().setClipPlane({ axis: 'x' });
    expect(useViewportStore.getState().clipPlane.axis).toBe('x');
  });

  it('setClipPlane updates offset', () => {
    useViewportStore.getState().setClipPlane({ offset: 5.5 });
    expect(useViewportStore.getState().clipPlane.offset).toBe(5.5);
  });

  it('setClipPlane flipped patch does not reset other fields', () => {
    useViewportStore.getState().setClipPlane({ axis: 'z', offset: 3 });
    useViewportStore.getState().setClipPlane({ flipped: true });
    const { axis, offset, flipped } = useViewportStore.getState().clipPlane;
    expect(axis).toBe('z');
    expect(offset).toBe(3);
    expect(flipped).toBe(true);
  });
});

describe('viewportStore — hiddenEntityIds', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('starts with no hidden entities', () => {
    expect(useViewportStore.getState().hiddenEntityIds.size).toBe(0);
  });

  it('toggleEntityVisibility hides an entity', () => {
    useViewportStore.getState().toggleEntityVisibility('ent-1');
    expect(useViewportStore.getState().hiddenEntityIds.has('ent-1')).toBe(true);
  });

  it('toggleEntityVisibility twice shows the entity again', () => {
    useViewportStore.getState().toggleEntityVisibility('ent-1');
    useViewportStore.getState().toggleEntityVisibility('ent-1');
    expect(useViewportStore.getState().hiddenEntityIds.has('ent-1')).toBe(false);
  });

  it('showAllEntities clears the hidden set', () => {
    useViewportStore.getState().toggleEntityVisibility('ent-1');
    useViewportStore.getState().toggleEntityVisibility('ent-2');
    useViewportStore.getState().showAllEntities();
    expect(useViewportStore.getState().hiddenEntityIds.size).toBe(0);
  });

  it('multiple entities can be hidden independently', () => {
    useViewportStore.getState().toggleEntityVisibility('a');
    useViewportStore.getState().toggleEntityVisibility('b');
    const { hiddenEntityIds } = useViewportStore.getState();
    expect(hiddenEntityIds.has('a')).toBe(true);
    expect(hiddenEntityIds.has('b')).toBe(true);
    expect(hiddenEntityIds.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ViewportControls component tests
// ---------------------------------------------------------------------------

describe('ViewportControls — display mode buttons', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('renders Shaded, Wire, and X-Ray buttons', () => {
    render(<ViewportControls />);
    // buttons are found by their text label (accessible name)
    expect(screen.getByRole('button', { name: 'Shaded' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Wire' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'X-Ray' })).toBeDefined();
  });

  it('Shaded button starts aria-pressed=true', () => {
    render(<ViewportControls />);
    const btn = screen.getByRole('button', { name: 'Shaded' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking Wire sets displayMode to "wireframe" in the store', () => {
    render(<ViewportControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Wire' }));
    expect(useViewportStore.getState().displayMode).toBe('wireframe');
  });

  it('clicking X-Ray sets displayMode to "xray" in the store', () => {
    render(<ViewportControls />);
    fireEvent.click(screen.getByRole('button', { name: 'X-Ray' }));
    expect(useViewportStore.getState().displayMode).toBe('xray');
  });

  it('clicking Shaded after X-Ray returns displayMode to "shaded"', () => {
    useViewportStore.setState({ displayMode: 'xray' });
    render(<ViewportControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Shaded' }));
    expect(useViewportStore.getState().displayMode).toBe('shaded');
  });

  it('active button reflects the current displayMode (wireframe)', () => {
    useViewportStore.setState({ displayMode: 'wireframe' });
    render(<ViewportControls />);
    const wireBtn = screen.getByRole('button', { name: 'Wire' });
    expect(wireBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ViewportControls — section plane toggle', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('renders a Section toggle button', () => {
    render(<ViewportControls />);
    // button text is "✂ Section" — match on text content
    expect(screen.getByRole('button', { name: /section/i })).toBeDefined();
  });

  it('clicking Section toggle enables the clip plane in the store', () => {
    render(<ViewportControls />);
    fireEvent.click(screen.getByRole('button', { name: /section/i }));
    expect(useViewportStore.getState().clipPlane.enabled).toBe(true);
  });

  it('section options are hidden when clip plane is disabled', () => {
    render(<ViewportControls />);
    // Axis select should not be in the DOM when disabled
    expect(screen.queryByLabelText(/section plane axis/i)).toBeNull();
  });

  it('section options are shown after enabling the clip plane', () => {
    useViewportStore.setState({
      clipPlane: { enabled: true, axis: 'y', offset: 0, flipped: false },
    });
    render(<ViewportControls />);
    expect(screen.getByLabelText(/section plane axis/i)).toBeDefined();
    expect(screen.getByLabelText(/section plane offset/i)).toBeDefined();
    expect(screen.getByLabelText(/flip section plane/i)).toBeDefined();
  });

  it('changing axis selector updates clipPlane.axis in store', () => {
    useViewportStore.setState({
      clipPlane: { enabled: true, axis: 'y', offset: 0, flipped: false },
    });
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText(/section plane axis/i), {
      target: { value: 'x' },
    });
    expect(useViewportStore.getState().clipPlane.axis).toBe('x');
  });

  it('changing offset slider updates clipPlane.offset in store', () => {
    useViewportStore.setState({
      clipPlane: { enabled: true, axis: 'y', offset: 0, flipped: false },
    });
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText(/section plane offset/i), {
      target: { value: '10' },
    });
    expect(useViewportStore.getState().clipPlane.offset).toBe(10);
  });

  it('checking flip toggles clipPlane.flipped in store', () => {
    useViewportStore.setState({
      clipPlane: { enabled: true, axis: 'y', offset: 0, flipped: false },
    });
    render(<ViewportControls />);
    fireEvent.click(screen.getByLabelText(/flip section plane/i));
    expect(useViewportStore.getState().clipPlane.flipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PropertiesPanel — Hide/Show visibility toggle
// ---------------------------------------------------------------------------

describe('PropertiesPanel — entity visibility toggle', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('shows a Hide button when a 3D entity is selected', () => {
    // Create a box and select it
    const result = useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
    const entityId = result.affected[0]!;
    useStore.getState().select([entityId]);

    render(<PropertiesPanel />);

    // Button text is "Hide" when entity is visible; title="Hide entity in viewport"
    expect(screen.getByTitle('Hide entity in viewport')).toBeDefined();
  });

  it('clicking Hide sets the entity as hidden in viewportStore', () => {
    const result = useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
    const entityId = result.affected[0]!;
    useStore.getState().select([entityId]);

    render(<PropertiesPanel />);

    fireEvent.click(screen.getByTitle('Hide entity in viewport'));

    expect(useViewportStore.getState().hiddenEntityIds.has(entityId)).toBe(true);
  });

  it('shows Show button when the entity is already hidden', () => {
    const result = useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
    const entityId = result.affected[0]!;
    useStore.getState().select([entityId]);
    useViewportStore.getState().toggleEntityVisibility(entityId);

    render(<PropertiesPanel />);

    expect(screen.getByTitle('Show entity in viewport')).toBeDefined();
  });

  it('clicking Show unhides the entity in viewportStore', () => {
    const result = useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
    const entityId = result.affected[0]!;
    useStore.getState().select([entityId]);
    useViewportStore.getState().toggleEntityVisibility(entityId);

    render(<PropertiesPanel />);

    fireEvent.click(screen.getByTitle('Show entity in viewport'));

    expect(useViewportStore.getState().hiddenEntityIds.has(entityId)).toBe(false);
  });

  it('does NOT mutate the document when hiding an entity', () => {
    const result = useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
    const entityId = result.affected[0]!;
    useStore.getState().select([entityId]);
    const docBefore = useStore.getState().document;

    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTitle('Hide entity in viewport'));

    // Document must be the same reference — no mutation (PRIME DIRECTIVE)
    expect(useStore.getState().document).toBe(docBefore);
  });
});
