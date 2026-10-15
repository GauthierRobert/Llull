import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { usePaletteStore, useStore, useToolStore } from '@ui/store';
import { resetOfflineStore } from '../helpers/storeTestHelpers';
import { Toolbar } from '@ui/components/toolbar/Toolbar';
import { ShortcutsDialog } from '@ui/components/ShortcutsDialog';
import { xy } from '../helpers/xy';

const button = (name: string): HTMLElement => screen.getByRole('button', { name });
/** Opens the Tools panel unless it is already open, then clicks one of its tools. */
const pick = (tool: string): void => {
  if (button('Tools').getAttribute('aria-expanded') !== 'true') fireEvent.click(button('Tools'));
  fireEvent.click(button(tool));
};
const selectAll = (): void => useStore.getState().select(useStore.getState().document.order);

describe('Toolbar (command bar)', () => {
  beforeEach(() => {
    resetOfflineStore();
    usePaletteStore.setState({ open: false });
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', gizmoMode: 'rotate', shortcutsOpen: false });
  });
  it('is one line when idle: Tools, the command palette trigger and a disabled Undo/Redo pair', () => {
    render(<Toolbar />);
    const bar = screen.getByRole('toolbar', { name: 'Main toolbar' });
    expect(Array.from(bar.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Tools',
      expect.stringMatching(/^Search or run a command/),
      'Undo',
      'Redo',
    ]);
    expect(screen.queryByRole('group', { name: 'Tools' })).toBeNull();
  });
  it('the ask button opens the command palette and advertises the shortcut', () => {
    render(<Toolbar />);
    const trigger = screen.getByRole('button', { name: /^Search or run a command/ });
    expect(trigger.getAttribute('aria-keyshortcuts')).toContain('Control+K');
    fireEvent.click(trigger);
    expect(usePaletteStore.getState().open).toBe(true);
  });
  it('each solid creates that solid, selects it and arms the move gizmo', () => {
    render(<Toolbar />);
    pick('Cylinder');
    expect(screen.queryByRole('group', { name: 'Tools' })).toBeNull();
    pick('Sphere');
    const { document } = useStore.getState();
    expect(document.order.map((id) => document.entities[id]?.kind)).toEqual(['cylinder', 'sphere']);
    expect(document.selection).toEqual([document.order[1]]);
    expect(useToolStore.getState().gizmoMode).toBe('translate');
  });
  it('a sketch tool arms in 2D and shows as a chip that puts it down', () => {
    render(<Toolbar />);
    pick('Line');
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'line', viewMode: '2d' });
    fireEvent.click(button('Tools'));
    expect(button('Line')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('Tools'));
    fireEvent.click(button('Stop the Line tool'));
    expect(useToolStore.getState().drawTool).toBe('none');
    expect(screen.queryByRole('button', { name: /Stop the/ })).toBeNull();
  });
  it('picking the armed sketch tool again disarms it', () => {
    render(<Toolbar />);
    pick('Line');
    pick('Line');
    expect(useToolStore.getState().drawTool).toBe('none');
  });
  it('selection actions appear only while something is selected; in 3D they set the gizmo mode', () => {
    const { rerender } = render(<Toolbar />);
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    pick('Box');
    rerender(<Toolbar />);
    fireEvent.click(button('Scale'));
    expect(useToolStore.getState().gizmoMode).toBe('scale');
    expect(button('Scale')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('Move'));
    expect(useToolStore.getState().gizmoMode).toBe('translate');
  });
  it('in 2D, Move arms the move tool; Rotate/Scale are disabled; Select puts it down', () => {
    useToolStore.setState({ viewMode: '2d' });
    const { rerender } = render(<Toolbar />);
    useStore.getState().dispatch('draw_polyline', { points: xy(0, 0, 1, 0) });
    selectAll();
    rerender(<Toolbar />);
    expect(button('Rotate')).toBeDisabled();
    fireEvent.click(button('Move'));
    expect(useToolStore.getState().drawTool).toBe('move');
    pick('Select');
    expect(useToolStore.getState().drawTool).toBe('none');
  });
  it('Duplicate and Delete act on the selection', () => {
    render(<Toolbar />);
    pick('Box');
    fireEvent.click(button('Duplicate'));
    expect(useStore.getState().document.order).toHaveLength(2);
    fireEvent.click(button('Delete'));
    expect(useStore.getState().document.order).toHaveLength(1);
  });
  it('Undo and Redo are always in the bar, disabled until applicable', () => {
    render(<Toolbar />);
    expect(button('Undo')).toBeDisabled();
    expect(button('Redo')).toBeDisabled();
    pick('Box');
    expect(button('Undo')).toBeEnabled();
    expect(button('Redo')).toBeDisabled();
    fireEvent.click(button('Undo'));
    expect(useStore.getState().document.order).toHaveLength(0);
    expect(button('Undo')).toBeDisabled();
    expect(button('Redo')).toBeEnabled();
    fireEvent.click(button('Redo'));
    expect(useStore.getState().document.order).toHaveLength(1);
  });
  it('the Tools panel closes on Escape, on a click outside, or from its button', () => {
    render(
      <>
        <Toolbar />
        <button type="button">outside</button>
      </>,
    );
    fireEvent.click(button('Tools'));
    expect(screen.getByRole('group', { name: 'Tools' })).toBeInTheDocument();
    expect(button('Tools')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Tools' })).toBeNull();
    fireEvent.click(button('Tools'));
    fireEvent.pointerDown(button('outside'));
    expect(screen.queryByRole('group', { name: 'Tools' })).toBeNull();
    fireEvent.click(button('Tools'));
    fireEvent.click(button('Tools'));
    expect(screen.queryByRole('group', { name: 'Tools' })).toBeNull();
  });
  it('a tool hint shows only for the hovered tool', () => {
    render(<Toolbar />);
    fireEvent.click(button('Tools'));
    expect(screen.queryByText(/click center, then a rim point/)).toBeNull();
    fireEvent.pointerEnter(button('Circle'));
    expect(screen.getByText(/click center, then a rim point/)).toBeInTheDocument();
  });
  it('the 3D / 2D switch in the Tools panel sets the view mode', () => {
    render(<Toolbar />);
    fireEvent.click(button('Tools'));
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
    fireEvent.click(button('Tools'));
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
