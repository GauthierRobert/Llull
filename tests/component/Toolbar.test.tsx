/**
 * Main toolbar: solids create + select in 3D, draw buttons arm 2D tools, transform buttons drive
 * the gizmo (3D) or the move tool (2D), edit buttons act on the selection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore, useToolStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { Toolbar } from '@ui/components/toolbar/Toolbar';
import { ShortcutsDialog } from '@ui/components/ShortcutsDialog';

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

describe('Toolbar', () => {
  beforeEach(() => {
    __resetIdCounter();
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected', localUndoStack: [], localRedoStack: [] });
    useToolStore.setState({
      viewMode: '3d',
      drawTool: 'none',
      gizmoMode: 'rotate',
      shortcutsOpen: false,
    });
  });

  it('each solid button creates that solid, selects it and arms the move gizmo', () => {
    render(<Toolbar />);
    fireEvent.click(button('Cylinder'));
    fireEvent.click(button('Sphere'));
    const { document } = useStore.getState();
    expect(document.order.map((id) => document.entities[id]?.kind)).toEqual(['cylinder', 'sphere']);
    expect(document.selection).toEqual([document.order[1]]);
    expect(useToolStore.getState().gizmoMode).toBe('translate');
  });

  it('draw buttons arm the 2D tool and switch to the 2D view; clicking again disarms', () => {
    render(<Toolbar />);
    fireEvent.click(button('Line'));
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'line', viewMode: '2d' });
    expect(button('Line')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('Line'));
    expect(useToolStore.getState().drawTool).toBe('none');
  });

  it('in 3D, Move / Rotate / Scale set the gizmo mode', () => {
    render(<Toolbar />);
    fireEvent.click(button('Scale'));
    expect(useToolStore.getState().gizmoMode).toBe('scale');
    expect(button('Scale')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('Move'));
    expect(useToolStore.getState().gizmoMode).toBe('translate');
  });

  it('in 2D, Move arms the move tool only with a selection; Rotate/Scale are disabled', () => {
    useToolStore.setState({ viewMode: '2d' });
    const { rerender } = render(<Toolbar />);
    expect(button('Move')).toBeDisabled();
    expect(button('Rotate')).toBeDisabled();
    useStore.getState().dispatch('draw_line', { start: [0, 0], end: [1, 0] });
    useStore.getState().select(useStore.getState().document.order);
    rerender(<Toolbar />);
    fireEvent.click(button('Move'));
    expect(useToolStore.getState().drawTool).toBe('move');
    fireEvent.click(button('Select'));
    expect(useToolStore.getState().drawTool).toBe('none');
  });

  it('Duplicate and Delete are disabled without a selection and act on it otherwise', () => {
    render(<Toolbar />);
    expect(button('Duplicate')).toBeDisabled();
    expect(button('Delete')).toBeDisabled();
    fireEvent.click(button('Box'));
    fireEvent.click(button('Duplicate'));
    expect(useStore.getState().document.order).toHaveLength(2);
    fireEvent.click(button('Delete'));
    expect(useStore.getState().document.order).toHaveLength(1);
  });

  it('Undo / Redo follow canUndo / canRedo', () => {
    render(<Toolbar />);
    expect(button('Undo')).toBeDisabled();
    fireEvent.click(button('Box'));
    fireEvent.click(button('Undo'));
    expect(useStore.getState().document.order).toHaveLength(0);
    fireEvent.click(button('Redo'));
    expect(useStore.getState().document.order).toHaveLength(1);
  });

  it('Shortcuts opens the shortcut sheet, which closes with its button', () => {
    render(
      <>
        <Toolbar />
        <ShortcutsDialog />
      </>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(button('Shortcuts'));
    expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /close shortcuts/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the shortcut sheet closes on Escape', () => {
    useToolStore.setState({ shortcutsOpen: true });
    render(<ShortcutsDialog />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(useToolStore.getState().shortcutsOpen).toBe(false);
  });
});
