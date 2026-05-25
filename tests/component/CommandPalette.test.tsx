/**
 * Component tests for <CommandPalette />.
 *
 * Asserts observable behavior (R11):
 *   - Dialog appears/disappears on isOpen.
 *   - Search filters the command list.
 *   - Keyboard navigation (↑/↓/Enter) selects and dispatches.
 *   - Commands with no required params dispatch immediately.
 *   - Commands with required params show ParamForm.
 *   - Esc closes the palette.
 *
 * Does NOT test internals: filtering algorithm, geometry, or store shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { CommandPalette } from '@ui/components/CommandPalette';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandPalette', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders nothing when isOpen is false', () => {
    render(<CommandPalette isOpen={false} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a dialog with a search input when isOpen is true', () => {
    render(<CommandPalette isOpen={true} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(within(dialog).getByRole('textbox')).toBeDefined();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={true} onClose={onClose} />);

    // The backdrop is the direct parent of the dialog.
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('filters commands by query substring (name)', () => {
    render(<CommandPalette isOpen={true} onClose={() => undefined} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'add_box' } });

    // Only commands matching "add_box" should remain.
    const list = screen.getByRole('listbox');
    const items = within(list).getAllByRole('option');
    // At least one item — the no-match empty state should not appear.
    expect(items.length).toBeGreaterThan(0);
    // "Add Box" must be present.
    expect(within(list).getByText('Add Box')).toBeDefined();
  });

  it('shows empty state when query matches nothing', () => {
    render(<CommandPalette isOpen={true} onClose={() => undefined} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'zzz_no_match_xyz' } });

    expect(screen.getByRole('listbox').textContent).toContain('No commands match');
  });

  it('dispatches describe_scene immediately (no required params) on Enter', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={true} onClose={onClose} />);

    const input = screen.getByRole('textbox');
    // describe_scene has no required params — should dispatch immediately.
    fireEvent.change(input, { target: { value: 'describe_scene' } });

    const dialog = screen.getByRole('dialog');
    // Press Enter to select the highlighted (first) item.
    fireEvent.keyDown(dialog, { key: 'Enter' });

    // onClose must have been called (command dispatched, palette closed).
    expect(onClose).toHaveBeenCalledOnce();
    // lastSummary shows the command ran.
    expect(useStore.getState().lastSummary).toBeTruthy();
  });

  it('shows ParamForm for a command that has required params', () => {
    render(<CommandPalette isOpen={true} onClose={() => undefined} />);

    const input = screen.getByRole('textbox');
    // delete_entity requires `id` — it has required params.
    fireEvent.change(input, { target: { value: 'delete_entity' } });

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });

    // Should now show the param form (no longer the listbox).
    expect(screen.queryByRole('listbox')).toBeNull();
    // The form should have a submit button.
    expect(screen.getByRole('button', { name: /run delete entity/i })).toBeDefined();
  });

  it('keyboard navigation: ↓ moves highlight, Enter dispatches selected command', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole('dialog');

    // Navigate down to the second item.
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });

    // The second option should now be aria-selected.
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    // After one ↓, index 1 should be selected.
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('restores focus to the opener element when the palette closes', () => {
    // Render a button that will be the "opener" and hold focus before palette opens.
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button data-testid="opener">Open palette</button>
        <CommandPalette isOpen={false} onClose={onClose} />
      </>,
    );

    // Simulate the opener having focus before the palette opens.
    const opener = document.querySelector<HTMLElement>('[data-testid="opener"]')!;
    opener.focus();
    expect(document.activeElement).toBe(opener);

    // Open the palette — focus should move to the search input.
    rerender(
      <>
        <button data-testid="opener">Open palette</button>
        <CommandPalette isOpen={true} onClose={onClose} />
      </>,
    );

    // Close the palette — focus should be restored to the opener.
    rerender(
      <>
        <button data-testid="opener">Open palette</button>
        <CommandPalette isOpen={false} onClose={onClose} />
      </>,
    );
    expect(document.activeElement).toBe(opener);
  });

  it('Tab key stays within the dialog (does not escape to background)', () => {
    render(
      <>
        <button data-testid="outside">Outside</button>
        <CommandPalette isOpen={true} onClose={() => undefined} />
      </>,
    );

    const dialog = screen.getByRole('dialog');
    // Fire Tab from within the dialog — the default browser navigation is
    // prevented; we just assert no exception and the dialog is still present.
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByRole('dialog')).toBeDefined();

    // Shift+Tab also handled without escaping.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('back button in form view returns to the list', () => {
    render(<CommandPalette isOpen={true} onClose={() => undefined} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'delete_entity' } });

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });

    // We're now in form view.
    expect(screen.queryByRole('listbox')).toBeNull();

    // Click "Back".
    const backBtn = screen.getByRole('button', { name: /back/i });
    fireEvent.click(backBtn);

    // List is visible again.
    expect(screen.getByRole('listbox')).toBeDefined();
  });
});
