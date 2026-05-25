/**
 * Component tests for <StatusBar /> (V3 — design system + status bar).
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Units and displayPrecision from the document are shown.
 *   - Selection count is reflected correctly for 0, 1, and N selections.
 *   - Last command summary is shown when present; absent when null.
 *   - Theme toggle button exists and switches the theme in the store.
 *
 * Does NOT test CSS variables or visual appearance — that is left for
 * Playwright / screenshot verification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { useThemeStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { StatusBar } from '@ui/components/StatusBar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  useThemeStore.setState({ theme: 'dark' });
}

/** Create a box entity via the store dispatch, return its id. */
function createBox(): string {
  const result = useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
  return result.affected[0]!;
}

// ---------------------------------------------------------------------------
// StatusBar — units display
// ---------------------------------------------------------------------------

describe('StatusBar — units', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows the document unit (mm by default)', () => {
    render(<StatusBar />);
    // The unit label value contains 'mm'
    expect(screen.getByText(/mm/)).toBeDefined();
  });

  it('shows the displayPrecision alongside the unit', () => {
    render(<StatusBar />);
    // Default precision is 3 → label shows "3dp"
    expect(screen.getByText(/3dp/)).toBeDefined();
  });

  it('reflects a changed unit after set_units dispatch', () => {
    useStore.getState().dispatch('set_units', { units: 'in', displayPrecision: 2 });
    render(<StatusBar />);

    // The units status item has aria-label "Units: in (2dp)"
    const unitsItem = screen.getByLabelText('Units: in (2dp)');
    expect(unitsItem).toBeDefined();
    expect(unitsItem.textContent).toContain('in');
    expect(unitsItem.textContent).toContain('2dp');
  });
});

// ---------------------------------------------------------------------------
// StatusBar — selection count
// ---------------------------------------------------------------------------

describe('StatusBar — selection count', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows "None" when nothing is selected', () => {
    render(<StatusBar />);
    expect(screen.getByText('None')).toBeDefined();
  });

  it('shows "1 entity" when a single entity is selected', () => {
    const id = createBox();
    useStore.getState().select([id]);

    render(<StatusBar />);
    expect(screen.getByText('1 entity')).toBeDefined();
  });

  it('shows "N entities" for multiple selected entities', () => {
    const id1 = createBox();
    const id2 = createBox();
    useStore.getState().select([id1, id2]);

    render(<StatusBar />);
    expect(screen.getByText('2 entities')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// StatusBar — last summary
// ---------------------------------------------------------------------------

describe('StatusBar — last command summary', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows nothing for the summary when lastSummary is null', () => {
    useStore.setState({ lastSummary: null });
    render(<StatusBar />);

    // No summary text should appear
    expect(screen.queryByLabelText(/last command/i)).toBeNull();
  });

  it('shows the last summary string after a command is dispatched', () => {
    useStore.getState().dispatch('add_box', { size: [2, 2, 2] });
    const { lastSummary } = useStore.getState();
    expect(lastSummary).toBeTruthy();

    render(<StatusBar />);

    // The summary span should contain the text
    const summaryEl = screen.getByLabelText(/last command/i);
    expect(summaryEl).toBeDefined();
    expect(summaryEl.textContent).toContain(lastSummary!);
  });

  it('shows an explicit summary string set directly on the store', () => {
    useStore.setState({ lastSummary: 'Box created at origin.' });

    render(<StatusBar />);

    expect(screen.getByText('Box created at origin.')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// StatusBar — theme toggle
// ---------------------------------------------------------------------------

describe('StatusBar — theme toggle', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders a theme toggle button', () => {
    render(<StatusBar />);
    const btn = screen.getByRole('button', { name: /switch to light theme/i });
    expect(btn).toBeDefined();
  });

  it('clicking the toggle flips the theme from dark to light', () => {
    useThemeStore.setState({ theme: 'dark' });
    render(<StatusBar />);

    const btn = screen.getByRole('button', { name: /switch to light theme/i });
    fireEvent.click(btn);

    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('clicking the toggle again flips back to dark', () => {
    useThemeStore.setState({ theme: 'light' });
    render(<StatusBar />);

    const btn = screen.getByRole('button', { name: /switch to dark theme/i });
    fireEvent.click(btn);

    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('the toggle aria-label changes to reflect the new target theme', () => {
    useThemeStore.setState({ theme: 'dark' });
    render(<StatusBar />);

    // When dark → button says "switch to light"
    expect(screen.getByRole('button', { name: /switch to light theme/i })).toBeDefined();
  });
});
