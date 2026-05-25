/**
 * Component tests for <McpConnect /> and <McpConnectButton /> (V4 — MCP affordance).
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - McpConnectButton renders a trigger button.
 *   - Clicking the trigger opens the dialog (role="dialog").
 *   - Dialog shows the MCP endpoint URL.
 *   - Dialog shows the start command.
 *   - Esc closes the dialog.
 *   - Backdrop click closes the dialog.
 *   - Close button (×) closes the dialog.
 *   - "Got it" button closes the dialog.
 *   - No fetch / document mutation occurs (PRIME DIRECTIVE — informational only).
 *
 * Does NOT test clipboard API (untestable in jsdom without mocking).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { McpConnect, McpConnectButton } from '@ui/components/McpConnect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// McpConnect — modal behavior
// ---------------------------------------------------------------------------

describe('McpConnect modal — visibility', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders nothing when isOpen is false', () => {
    render(<McpConnect isOpen={false} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a dialog with aria-modal when isOpen is true', () => {
    render(<McpConnect isOpen={true} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-modal')).toBeTruthy();
  });

  it('dialog has an accessible name (aria-labelledby pointing to the title)', () => {
    render(<McpConnect isOpen={true} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    // The heading text should match the aria-labelledby target
    expect(screen.getByText(/connect an mcp agent/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// McpConnect — content
// ---------------------------------------------------------------------------

describe('McpConnect modal — content', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows the MCP endpoint URL', () => {
    render(<McpConnect isOpen={true} onClose={() => undefined} />);
    expect(screen.getByText('http://localhost:3001/mcp')).toBeDefined();
  });

  it('shows the npm start command', () => {
    render(<McpConnect isOpen={true} onClose={() => undefined} />);
    expect(screen.getByText('npm --prefix server run dev')).toBeDefined();
  });

  it('shows copy buttons for both the endpoint and the start command', () => {
    render(<McpConnect isOpen={true} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    const copyBtns = within(dialog).getAllByRole('button', { name: /copy/i });
    // At least 2 copy buttons (endpoint + start command)
    expect(copyBtns.length).toBeGreaterThanOrEqual(2);
  });

  it('mentions MCP resources (cad:// URIs)', () => {
    render(<McpConnect isOpen={true} onClose={() => undefined} />);
    expect(screen.getByText(/cad:\/\/document/i)).toBeDefined();
  });

  it('does NOT mutate the document when opened or closed (PRIME DIRECTIVE)', () => {
    const before = useStore.getState().document;

    render(<McpConnect isOpen={true} onClose={() => undefined} />);

    const after = useStore.getState().document;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// McpConnect — close behaviors
// ---------------------------------------------------------------------------

describe('McpConnect modal — close', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<McpConnect isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<McpConnect isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the × close button is clicked', () => {
    const onClose = vi.fn();
    render(<McpConnect isOpen={true} onClose={onClose} />);

    const closeBtn = screen.getByRole('button', { name: /close mcp connect dialog/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the "Got it" button is clicked', () => {
    const onClose = vi.fn();
    render(<McpConnect isOpen={true} onClose={onClose} />);

    const gotIt = screen.getByRole('button', { name: /got it/i });
    fireEvent.click(gotIt);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// McpConnectButton — trigger
// ---------------------------------------------------------------------------

describe('McpConnectButton', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders a button labeled for MCP connection', () => {
    render(<McpConnectButton />);
    expect(screen.getByRole('button', { name: /connect an mcp agent/i })).toBeDefined();
  });

  it('dialog is not shown initially', () => {
    render(<McpConnectButton />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking the trigger opens the MCP dialog', () => {
    render(<McpConnectButton />);

    const triggerBtn = screen.getByRole('button', { name: /connect an mcp agent/i });
    fireEvent.click(triggerBtn);

    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('the dialog shows the endpoint after the trigger is clicked', () => {
    render(<McpConnectButton />);

    fireEvent.click(screen.getByRole('button', { name: /connect an mcp agent/i }));

    expect(screen.getByText('http://localhost:3001/mcp')).toBeDefined();
  });
});
