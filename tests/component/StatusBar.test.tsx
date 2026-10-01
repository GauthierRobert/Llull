/**
 * Component tests for <StatusBar />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Live connection indicator reflects liveStatus from the store.
 *   - Units and displayPrecision from the document are shown.
 *   - Selection count is reflected correctly for 0, 1, and N selections.
 *   - Last command summary is shown when present; absent when null.
 *   - Entity count is shown.
 *
 * Does NOT test CSS variables or visual appearance — that is left for
 * Playwright / screenshot verification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { StatusBar } from '@ui/components/StatusBar';
import { localDispatch } from '../helpers/storeTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
    liveStatus: 'connecting',
  });
}

/** Create a box entity via localDispatch (bypasses network), return its id. */
function createBox(): string {
  const result = localDispatch('add_box', { size: [2, 2, 2] });
  return result.affected[0]!;
}

// ---------------------------------------------------------------------------
// StatusBar — live indicator
// ---------------------------------------------------------------------------

describe('StatusBar — live indicator', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows "Live" when liveStatus is connected', () => {
    useStore.setState({ liveStatus: 'connected' });
    render(<StatusBar />);
    expect(screen.getByLabelText(/mcp stream: live/i)).toBeDefined();
  });

  it('shows "Offline (local)" when liveStatus is disconnected', () => {
    useStore.setState({ liveStatus: 'disconnected' });
    render(<StatusBar />);
    expect(screen.getByLabelText(/mcp stream: offline \(local\)/i)).toBeDefined();
  });

  it('shows "Connecting" text when liveStatus is connecting', () => {
    useStore.setState({ liveStatus: 'connecting' });
    render(<StatusBar />);
    expect(screen.getByLabelText(/mcp stream: connecting/i)).toBeDefined();
  });
});

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
    localDispatch('set_units', { units: 'in', displayPrecision: 2 });
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

  it('shows the last summary string when set directly on the store', () => {
    // lastSummary is now set from the server response after dispatch.
    // Set it directly to test the rendering behavior.
    useStore.setState({ lastSummary: 'Box added at origin.' });

    render(<StatusBar />);

    // The summary span should contain the text
    const summaryEl = screen.getByLabelText(/last command/i);
    expect(summaryEl).toBeDefined();
    expect(summaryEl.textContent).toContain('Box added at origin.');
  });

  it('shows an explicit summary string set directly on the store', () => {
    useStore.setState({ lastSummary: 'Box created at origin.' });

    render(<StatusBar />);

    expect(screen.getByText('Box created at origin.')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// StatusBar — entity count
// ---------------------------------------------------------------------------

describe('StatusBar — entity count', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows 0 entities for an empty document', () => {
    render(<StatusBar />);
    expect(screen.getByLabelText('Entities: 0')).toBeDefined();
  });

  it('counts entities in the document', () => {
    createBox();
    createBox();
    render(<StatusBar />);
    expect(screen.getByLabelText('Entities: 2')).toBeDefined();
  });
});
