/**
 * <CommandPalette /> + <PaletteResultToast />: Ctrl/Cmd+K opens, typing filters, keyboard runs an
 * action, a command with params opens its generated form and dispatches parsed params, Escape
 * steps back then closes, and the run's summary is toasted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePaletteStore, useStore, useToolStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import type { DispatchOptions } from '@ui/store/storeTypes';
import { CommandPalette } from '@ui/components/commandPalette/CommandPalette';
import { PaletteResultToast } from '@ui/components/commandPalette/PaletteResultToast';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';

function Harness(): React.ReactElement {
  useKeyboardShortcuts();
  return (
    <>
      <CommandPalette />
      <PaletteResultToast />
    </>
  );
}

const dispatch = vi.fn();

function search(text: string): HTMLElement {
  const input = screen.getByRole('combobox', { name: 'Search commands' });
  fireEvent.change(input, { target: { value: text } });
  return input;
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePaletteStore.setState({ open: false, recentIds: [], result: null });
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', modifyTool: 'none' });
    useStore.setState({
      document: { ...createEmptyDocument(), selection: ['box-1.1'] },
      lastSummary: null,
      dispatch,
    });
  });

  it('opens with Ctrl+K (and Cmd+K) and closes with Escape', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeDefined();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('filters as you type and runs the active action with Enter', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    const input = search('draw line');
    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).toContain('Draw line');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useToolStore.getState().drawTool).toBe('line');
    expect(usePaletteStore.getState().open).toBe(false);
    expect(usePaletteStore.getState().recentIds[0]).toBe('action:draw-line');
  });

  it('moves the active option with the arrow keys', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    const input = search('add');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('shows an empty state when nothing matches', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    search('qqqzzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No matching command/)).toBeDefined();
  });

  it('opens the generated form for a command with params, pre-filled from the selection', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    search('move entity');
    fireEvent.click(screen.getByRole('option', { name: /Move entity…/ }));
    const form = screen.getByRole('form', { name: 'Move entity parameters' });
    expect(form).toBeDefined();
    expect((screen.getByLabelText(/^Id/) as HTMLInputElement).value).toBe('box-1.1');

    fireEvent.change(screen.getByLabelText(/^Delta/), { target: { value: '10, 0, 0' } });
    fireEvent.submit(form);
    expect(dispatch).toHaveBeenCalledWith(
      'move_entity',
      { id: 'box-1.1', delta: [10, 0, 0] },
      expect.objectContaining({ selectAffected: true }),
    );
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('shows field errors instead of dispatching invalid input, and Escape goes back', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    search('add box');
    fireEvent.click(screen.getByRole('option', { name: /Add box…/ }));
    const form = screen.getByRole('form');
    fireEvent.submit(form);
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);

    fireEvent.keyDown(form, { key: 'Escape' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('combobox')).toBeDefined();
  });

  it('runs a parameterless command at once and toasts its own result', () => {
    dispatch.mockImplementation((_name: string, _params: unknown, options?: DispatchOptions) =>
      options?.onResult?.({ summary: 'Scene: 0 entities.', changed: false }),
    );
    usePaletteStore.setState({ open: true });
    const { container } = render(<Harness />);
    const input = search('describe scene');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledWith(
      'describe_scene',
      {},
      expect.objectContaining({
        selectAffected: true,
      }),
    );
    expect(screen.getByRole('status').textContent).toContain('Scene: 0 entities.');
    // A read-only query that changes nothing is not a failure.
    expect(container.querySelector('.palette-toast--failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }));
    expect(container.querySelector('.palette-toast')).toBeNull();
  });

  it('flags a rejected run and auto-dismisses, even after a hover + dismiss', () => {
    vi.useFakeTimers();
    try {
      dispatch.mockImplementation((_name: string, _params: unknown, options?: DispatchOptions) =>
        options?.onResult?.({ summary: 'add_box rejected: invalid params', changed: false }),
      );
      const { container } = render(<Harness />);
      const runAddBox = (): void => {
        act(() => usePaletteStore.setState({ open: true }));
        search('add box');
        fireEvent.click(screen.getByRole('option', { name: /Add box…/ }));
        fireEvent.change(screen.getByLabelText(/^Size/), { target: { value: '1, 1, 1' } });
        fireEvent.submit(screen.getByRole('form'));
      };

      runAddBox();
      const toast = container.querySelector('.palette-toast');
      expect(toast?.classList.contains('palette-toast--failed')).toBe(true);
      fireEvent.mouseEnter(toast as Element);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }));
      expect(container.querySelector('.palette-toast')).toBeNull();

      runAddBox();
      act(() => {
        vi.advanceTimersByTime(7000);
      });
      expect(container.querySelector('.palette-toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores summaries from other dispatches', () => {
    render(<Harness />);
    act(() => useStore.setState({ lastSummary: 'Undid last step.' }));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('is modal: canvas shortcuts do not act behind it, Escape closes it', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(useToolStore.getState().drawTool).toBe('none');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('traps Tab inside the dialog', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    const input = screen.getByRole('combobox');
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('asks before running a destructive command, even without required params', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    const input = search('clear document');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole('note').textContent).toMatch(/removes document content/);
    fireEvent.submit(screen.getByRole('form'));
    expect(dispatch).toHaveBeenCalledWith('clear_document', {}, expect.anything());
    expect(usePaletteStore.getState().recentIds[0]).toBe('command:clear_document');
  });

  it('submits a required boolean as displayed', () => {
    usePaletteStore.setState({ open: true });
    render(<Harness />);
    search('set step suppressed');
    fireEvent.click(screen.getByRole('option', { name: /Set step suppressed…/ }));
    fireEvent.change(screen.getByLabelText(/^Step id/), { target: { value: 'step-1' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(dispatch).toHaveBeenCalledWith(
      'set_step_suppressed',
      expect.objectContaining({ stepId: 'step-1', suppressed: true }),
      expect.anything(),
    );
  });
});
