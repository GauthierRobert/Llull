import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore, useToolStore } from '@ui/store';
import { resetOfflineStore } from '../helpers/storeTestHelpers';
import { Toolbar } from '@ui/components/toolbar/Toolbar';
import { ShortcutsDialog } from '@ui/components/ShortcutsDialog';
import { xy } from '../helpers/xy';

const button = (name: string): HTMLElement => screen.getByRole('button', { name });
/** Opens a dock tray (Sketch tools / Solid tools) unless it is already open, then clicks one of its tools. */
const pick = (tray: 'Sketch tools' | 'Solid tools', tool: string): void => {
  if (button(tray).getAttribute('aria-expanded') !== 'true') fireEvent.click(button(tray));
  fireEvent.click(button(tool));
};

describe('Toolbar (dock)', () => {
  beforeEach(() => {
    resetOfflineStore();
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', gizmoMode: 'rotate', shortcutsOpen: false });
  });
  it('each solid button creates that solid, selects it and arms the move gizmo', () => {
    render(<Toolbar />);
    pick('Solid tools', 'Cylinder');
    pick('Solid tools', 'Sphere');
    const { document } = useStore.getState();
    expect(document.order.map((id) => document.entities[id]?.kind)).toEqual(['cylinder', 'sphere']);
    expect(document.selection).toEqual([document.order[1]]);
    expect(useToolStore.getState().gizmoMode).toBe('translate');
  });
  it('draw buttons arm the 2D tool and switch to the 2D view; clicking again disarms', () => {
    render(<Toolbar />);
    pick('Sketch tools', 'Line');
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'line', viewMode: '2d' });
    expect(screen.queryByRole('group', { name: 'Sketch tools' })).toBeNull();
    expect(button('Sketch tools')).toHaveTextContent('Line');
    fireEvent.click(button('Sketch tools'));
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
    useStore.getState().dispatch('draw_polyline', { points: xy(0, 0, 1, 0) });
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
    pick('Solid tools', 'Box');
    fireEvent.click(button('Duplicate'));
    expect(useStore.getState().document.order).toHaveLength(2);
    fireEvent.click(button('Delete'));
    expect(useStore.getState().document.order).toHaveLength(1);
  });
  it('Undo / Redo follow canUndo / canRedo', () => {
    render(<Toolbar />);
    expect(button('Undo')).toBeDisabled();
    pick('Solid tools', 'Box');
    fireEvent.click(button('Undo'));
    expect(useStore.getState().document.order).toHaveLength(0);
    fireEvent.click(button('Redo'));
    expect(useStore.getState().document.order).toHaveLength(1);
  });
  it('a tray toggles from its trigger and closes on Escape or a click outside the dock', () => {
    render(
      <>
        <Toolbar />
        <button type="button">outside</button>
      </>,
    );
    fireEvent.click(button('Solid tools'));
    expect(screen.getByRole('group', { name: 'Solid tools' })).toBeInTheDocument();
    expect(button('Solid tools')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Solid tools' })).toBeNull();
    fireEvent.click(button('Sketch tools'));
    fireEvent.pointerDown(button('outside'));
    expect(screen.queryByRole('group', { name: 'Sketch tools' })).toBeNull();
    fireEvent.click(button('Sketch tools'));
    fireEvent.click(button('Sketch tools'));
    expect(screen.queryByRole('group', { name: 'Sketch tools' })).toBeNull();
  });
  it('the tray hint describes the hovered tool', () => {
    render(<Toolbar />);
    fireEvent.click(button('Sketch tools'));
    fireEvent.pointerEnter(button('Circle'));
    expect(screen.getByText(/click center, then a rim point/)).toBeInTheDocument();
  });
  it('the 3D / 2D switch sets the view mode', () => {
    render(<Toolbar />);
    expect(screen.getByRole('group', { name: 'View mode' })).toBeInTheDocument();
    fireEvent.click(button('2D'));
    expect(useToolStore.getState().viewMode).toBe('2d');
    expect(button('2D')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('3D'));
    expect(useToolStore.getState().viewMode).toBe('3d');
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
