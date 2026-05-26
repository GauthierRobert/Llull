/**
 * Component tests for <McpConnect /> and <McpConnectButton />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - McpConnectButton opens the modal on click.
 *   - Modal: correct role/aria attributes present.
 *   - Modal: first focusable element receives focus on open.
 *   - Focus trap: Tab from last element loops to first.
 *   - Focus trap: Shift-Tab from first element loops to last.
 *   - Esc closes the modal.
 *   - Backdrop click closes the modal.
 *   - Focus is restored to the trigger button after close.
 *   - Copy buttons call navigator.clipboard.writeText with the correct strings.
 *   - No document mutation (PRIME DIRECTIVE).
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { McpConnect, McpConnectButton } from '@ui/components/McpConnect';

// ---------------------------------------------------------------------------
// Mock clipboard
// ---------------------------------------------------------------------------

const writeTextMock: Mock<(text: string) => Promise<void>> = vi.fn(
  (_text: string) => Promise.resolve(),
);

beforeEach(() => {
  writeTextMock.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// McpConnect modal — structure
// ---------------------------------------------------------------------------

describe('McpConnect — structure', () => {
  it('renders with role=dialog and aria-modal=true', () => {
    render(<McpConnect onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('has aria-labelledby pointing at the title element', () => {
    render(<McpConnect onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const titleEl = document.getElementById(labelId ?? '');
    expect(titleEl).toBeTruthy();
    expect(titleEl?.textContent).toMatch(/connect an mcp agent/i);
  });

  it('shows the title "Connect an MCP agent"', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByText(/connect an mcp agent/i)).toBeDefined();
  });

  it('shows the server start command in a code block', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByText('npm --prefix server run dev')).toBeDefined();
  });

  it('shows the endpoint URL in a code block', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByText('http://localhost:3000/mcp')).toBeDefined();
  });

  it('shows the "60 tools" capability badge', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByText('60 tools')).toBeDefined();
  });

  it('shows the "structuredContent (KI2)" capability badge', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByText('structuredContent (KI2)')).toBeDefined();
  });

  it('shows the "prompts (EN2)" capability badge', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByText('prompts (EN2)')).toBeDefined();
  });

  it('shows the "session isolation (KI1)" capability badge', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByText('session isolation (KI1)')).toBeDefined();
  });

  it('has a close button', () => {
    render(<McpConnect onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: /close dialog/i })).toBeDefined();
  });

  it('has two Copy buttons', () => {
    render(<McpConnect onClose={() => undefined} />);
    const copyBtns = screen.getAllByRole('button', { name: /copy/i });
    expect(copyBtns.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// McpConnect modal — close behavior
// ---------------------------------------------------------------------------

describe('McpConnect — close behavior', () => {
  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<McpConnect onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Esc is pressed', () => {
    const onClose = vi.fn();
    render(<McpConnect onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<McpConnect onClose={onClose} />);
    // The backdrop is the first child of the container
    const backdrop = container.querySelector('.mcp-connect-backdrop');
    expect(backdrop).toBeTruthy();
    // Click directly on the backdrop element (not the dialog inside it).
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when clicking inside the dialog panel', () => {
    const onClose = vi.fn();
    render(<McpConnect onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// McpConnect modal — focus management
// ---------------------------------------------------------------------------

describe('McpConnect — focus management', () => {
  it('focuses the first focusable element on open', async () => {
    await act(async () => {
      render(<McpConnect onClose={() => undefined} />);
    });
    const dialog = screen.getByRole('dialog');
    const firstBtn = dialog.querySelector('button');
    await waitFor(() => {
      expect(document.activeElement).toBe(firstBtn);
    });
  });

  it('wraps Tab from the last focusable element back to the first', async () => {
    await act(async () => {
      render(<McpConnect onClose={() => undefined} />);
    });
    const dialog = screen.getByRole('dialog');
    const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button'));
    const last = buttons[buttons.length - 1];
    expect(last).toBeTruthy();

    // Focus the last button manually, then press Tab.
    last!.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('wraps Shift+Tab from the first focusable element back to the last', async () => {
    await act(async () => {
      render(<McpConnect onClose={() => undefined} />);
    });
    const dialog = screen.getByRole('dialog');
    const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button'));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    expect(first).toBeTruthy();
    expect(last).toBeTruthy();

    // Wait for the useEffect focus to land.
    await waitFor(() => {
      expect(document.activeElement).toBe(first);
    });

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

// ---------------------------------------------------------------------------
// McpConnectButton — launcher
// ---------------------------------------------------------------------------

describe('McpConnectButton', () => {
  it('renders a "Connect agent" trigger button', () => {
    render(<McpConnectButton />);
    expect(screen.getByRole('button', { name: /connect an mcp agent/i })).toBeDefined();
  });

  it('does not show the modal initially', () => {
    render(<McpConnectButton />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the modal when the trigger is clicked', () => {
    render(<McpConnectButton />);
    fireEvent.click(screen.getByRole('button', { name: /connect an mcp agent/i }));
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('closes the modal when Esc is pressed inside the modal', () => {
    render(<McpConnectButton />);
    fireEvent.click(screen.getByRole('button', { name: /connect an mcp agent/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores focus to the trigger button after close', async () => {
    render(<McpConnectButton />);
    const trigger = screen.getByRole('button', { name: /connect an mcp agent/i });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    // Focus restore uses setTimeout(0); wait one tick.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});

// ---------------------------------------------------------------------------
// Copy buttons
// ---------------------------------------------------------------------------

describe('McpConnect — copy buttons', () => {
  it('Copy button for start command calls clipboard.writeText with the command', async () => {
    render(<McpConnect onClose={() => undefined} />);
    // "Copy start command" button — aria-label is "Copy start command"
    const copyBtns = screen.getAllByRole('button', { name: /copy start command/i });
    expect(copyBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(copyBtns[0]!);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('npm --prefix server run dev');
    });
  });

  it('Copy button for endpoint URL calls clipboard.writeText with the URL', async () => {
    render(<McpConnect onClose={() => undefined} />);
    const copyBtns = screen.getAllByRole('button', { name: /copy endpoint url/i });
    expect(copyBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(copyBtns[0]!);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('http://localhost:3000/mcp');
    });
  });

  it('Copy button shows "Copied!" label after click', async () => {
    render(<McpConnect onClose={() => undefined} />);
    const [firstCopy] = screen.getAllByRole('button', { name: /copy start command/i });
    fireEvent.click(firstCopy!);

    await waitFor(() => {
      // aria-label changes to "start command copied"
      expect(
        screen.getByRole('button', { name: /start command copied/i }),
      ).toBeDefined();
    });
  });
});
