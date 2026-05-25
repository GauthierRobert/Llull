/**
 * Component tests for <EmptyState /> — viewer mode.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Empty-state is rendered when document.order is empty.
 *   - Empty-state is absent once any entity exists in the document.
 *   - Dismiss button hides the overlay without changing the document.
 *   - Key viewer-mode copy is visible.
 *
 * Does NOT test geometry, CSS variables, or r3f internals.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { EmptyState } from '@ui/components/EmptyState';
import { localDispatch } from '../helpers/storeTestHelpers';

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
    expect(screen.getByRole('status', { name: /waiting for mcp agent/i })).toBeDefined();
  });

  it('shows the viewer heading', () => {
    render(<EmptyState />);
    expect(screen.getByText(/waiting for your mcp agent/i)).toBeDefined();
  });

  it('includes a "ask Claude" message', () => {
    render(<EmptyState />);
    expect(screen.getByText(/ask claude/i)).toBeDefined();
  });

  it('does NOT render when the document has at least 1 entity', () => {
    localDispatch('add_box', { size: [2, 2, 2] });

    render(<EmptyState />);
    expect(screen.queryByRole('status', { name: /waiting for mcp agent/i })).toBeNull();
  });

  it('does NOT render when the document has multiple entities', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('add_box', { size: [2, 2, 2] });

    render(<EmptyState />);
    expect(screen.queryByRole('status', { name: /waiting for mcp agent/i })).toBeNull();
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

    expect(queryByRole('status', { name: /waiting for mcp agent/i })).toBeNull();
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
// Tests — viewer content
// ---------------------------------------------------------------------------

describe('EmptyState — content', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows viewer tips list', () => {
    render(<EmptyState />);
    expect(screen.getByRole('list', { name: /viewer tips/i })).toBeDefined();
  });

  it('mentions MCP in the tips', () => {
    render(<EmptyState />);
    const matches = screen.getAllByText(/MCP/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
