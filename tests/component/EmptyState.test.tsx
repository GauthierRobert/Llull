/**
 * Component tests for <EmptyState /> (V4 — first-run onboarding).
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Empty-state is rendered when document.order is empty.
 *   - Empty-state is absent once any entity exists in the document.
 *   - Dismiss button hides the overlay without changing the document.
 *   - Key copy of the getting-started message is visible.
 *
 * Does NOT test geometry, CSS variables, or r3f internals.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { EmptyState } from '@ui/components/EmptyState';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// Tests — visibility based on entity count
// ---------------------------------------------------------------------------

describe('EmptyState — visibility', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders the empty-state when the document has 0 entities', () => {
    render(<EmptyState />);
    expect(screen.getByRole('status', { name: /getting started/i })).toBeDefined();
  });

  it('shows the heading "No geometry yet"', () => {
    render(<EmptyState />);
    expect(screen.getByText('No geometry yet')).toBeDefined();
  });

  it('includes a mention of the command palette shortcut', () => {
    render(<EmptyState />);
    // The subheading references Ctrl/Cmd K
    expect(screen.getByText(/ctrl\/cmd k/i)).toBeDefined();
  });

  it('does NOT render when the document has at least 1 entity', () => {
    // Dispatch a command to create a box (document mutation through the store).
    useStore.getState().dispatch('add_box', { size: [2, 2, 2] });

    render(<EmptyState />);
    expect(screen.queryByRole('status', { name: /getting started/i })).toBeNull();
  });

  it('does NOT render when the document has multiple entities', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    useStore.getState().dispatch('add_box', { size: [2, 2, 2] });

    render(<EmptyState />);
    expect(screen.queryByRole('status', { name: /getting started/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — dismiss button
// ---------------------------------------------------------------------------

describe('EmptyState — dismiss', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders a dismiss button', () => {
    render(<EmptyState />);
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeDefined();
  });

  it('hides the overlay after the dismiss button is clicked', () => {
    const { queryByRole } = render(<EmptyState />);

    const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    expect(queryByRole('status', { name: /getting started/i })).toBeNull();
  });

  it('does not change the document when dismissed (PRIME DIRECTIVE)', () => {
    const before = useStore.getState().document;

    render(<EmptyState />);
    const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    const after = useStore.getState().document;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tests — getting-started content
// ---------------------------------------------------------------------------

describe('EmptyState — content', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows getting-started tips list', () => {
    render(<EmptyState />);
    expect(screen.getByRole('list', { name: /getting started tips/i })).toBeDefined();
  });

  it('mentions MCP in the tips', () => {
    render(<EmptyState />);
    // At least one element should mention MCP
    const matches = screen.getAllByText(/MCP/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
