import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { usePaletteStore, useStore, useToolStore } from '@ui/store';
import { useFeatureSessionStore } from '@ui/store/featureSessionStore';
import { resetOfflineStore } from '../helpers/storeTestHelpers';
import { Toolbar } from '@ui/components/toolbar/Toolbar';
import { xy } from '../helpers/xy';

const button = (name: string): HTMLElement => screen.getByRole('button', { name });
const flyout = (group: string): HTMLElement | null => screen.queryByRole('group', { name: `${group} tools` });
/** Opens the tool group unless it is already open, then clicks one of its tools. */
const pick = (group: string, tool: string): void => {
  if (button(group).getAttribute('aria-expanded') !== 'true') fireEvent.click(button(group));
  fireEvent.click(within(flyout(group) as HTMLElement).getByRole('button', { name: tool }));
};
const selectAll = (): void => act(() => useStore.getState().select(useStore.getState().document.order));
const drawRectangle = (): void =>
  act(() => useStore.getState().dispatch('draw_rectangle', { width: 2, height: 1 }, { selectAffected: true }));
const selectionBar = (): HTMLElement | null => screen.queryByRole('toolbar', { name: 'Selection actions' });

describe('Toolbar (command bar)', () => {
  beforeEach(() => {
    resetOfflineStore();
    usePaletteStore.setState({ open: false, pendingCommand: null, pendingParams: null });
    useFeatureSessionStore.getState().end();
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', modifyTool: 'none', gizmoMode: 'rotate', shortcutsOpen: false });
  });
  it('names every tool family: Select, Sketch, Solid, Modify, Inspect, then search and Undo / Redo', () => {
    render(<Toolbar />);
    const bar = screen.getByRole('toolbar', { name: 'Main toolbar' });
    expect(Array.from(bar.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Select',
      'Sketch',
      'Solid',
      'Modify',
      'Inspect',
      expect.stringMatching(/^Search or run a command/),
      'Undo',
      'Redo',
    ]);
    for (const group of ['Sketch', 'Solid', 'Modify', 'Inspect']) expect(button(group)).toHaveTextContent(group);
    expect(button('Select')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('group', { name: /tools$/ })).toBeNull();
    expect(selectionBar()).toBeNull();
  });
  it('the search button opens the command palette and advertises the shortcut', () => {
    render(<Toolbar />);
    const trigger = screen.getByRole('button', { name: /^Search or run a command/ });
    expect(trigger.getAttribute('aria-keyshortcuts')).toContain('Control+K');
    fireEvent.click(trigger);
    expect(usePaletteStore.getState().open).toBe(true);
  });
  it('each solid creates that solid, selects it and arms the move gizmo', () => {
    render(<Toolbar />);
    pick('Solid', 'Cylinder');
    expect(flyout('Solid')).toBeNull();
    pick('Solid', 'Sphere');
    const { document } = useStore.getState();
    expect(document.order.map((id) => document.entities[id]?.kind)).toEqual(['cylinder', 'sphere']);
    expect(document.selection).toEqual([document.order[1]]);
    expect(useToolStore.getState().gizmoMode).toBe('translate');
  });
  it('a sketch tool arms in 2D; the Sketch button carries it and Select puts it down', () => {
    render(<Toolbar />);
    pick('Sketch', 'Line');
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'line', viewMode: '2d' });
    expect(button('Sketch')).toHaveTextContent('Line');
    expect(button('Select')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button('Sketch'));
    expect(within(flyout('Sketch') as HTMLElement).getByRole('button', { name: 'Line' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('Select'));
    expect(useToolStore.getState().drawTool).toBe('none');
    expect(flyout('Sketch')).toBeNull();
    expect(button('Sketch')).toHaveTextContent('Sketch');
  });
  it('picking the armed sketch tool again disarms it', () => {
    render(<Toolbar />);
    pick('Sketch', 'Line');
    pick('Sketch', 'Line');
    expect(useToolStore.getState().drawTool).toBe('none');
  });
  it('a flyout closes on Escape, on a click outside, or from its button', () => {
    render(
      <>
        <Toolbar />
        <button type="button">outside</button>
      </>,
    );
    fireEvent.click(button('Sketch'));
    expect(flyout('Sketch')).toBeInTheDocument();
    expect(button('Sketch')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(flyout('Sketch')).toBeNull();
    fireEvent.click(button('Sketch'));
    fireEvent.pointerDown(button('outside'));
    expect(flyout('Sketch')).toBeNull();
    fireEvent.click(button('Sketch'));
    fireEvent.click(button('Sketch'));
    expect(flyout('Sketch')).toBeNull();
  });
  it('with a flyout open, pointing at another tool family switches to it; idle, pointing opens nothing', () => {
    render(<Toolbar />);
    fireEvent.pointerEnter(button('Solid'));
    expect(flyout('Solid')).toBeNull();
    fireEvent.click(button('Sketch'));
    fireEvent.pointerEnter(button('Solid'));
    expect(flyout('Sketch')).toBeNull();
    expect(flyout('Solid')).toBeInTheDocument();
  });
  it('the flyout describes the pointed tool', () => {
    render(<Toolbar />);
    fireEvent.click(button('Sketch'));
    expect(screen.getByRole('status')).toHaveTextContent(/point at a tool/i);
    fireEvent.pointerEnter(button('Circle'));
    expect(screen.getByRole('status')).toHaveTextContent(/click center, then a rim point/);
  });
  it('Modify opens the command form, with the boolean operation and the selected solids filled in', () => {
    render(<Toolbar />);
    pick('Solid', 'Box');
    pick('Solid', 'Cylinder');
    selectAll();
    const [a, b] = useStore.getState().document.order;
    pick('Modify', 'Subtract');
    expect(usePaletteStore.getState()).toMatchObject({ open: true, pendingCommand: 'boolean', pendingParams: { op: 'subtract', a, b } });
  });
  it('Modify > Extrude starts the drag handle on a selected sketch, else opens the extrude form', () => {
    render(<Toolbar />);
    pick('Modify', 'Extrude');
    expect(usePaletteStore.getState()).toMatchObject({ open: true, pendingCommand: 'extrude_profile' });
    act(() => usePaletteStore.getState().setOpen(false));
    drawRectangle();
    const [rectId] = useStore.getState().document.selection;
    pick('Modify', 'Extrude');
    expect(usePaletteStore.getState().open).toBe(false);
    expect(useFeatureSessionStore.getState().session).toMatchObject({ kind: 'extrude', targetId: rectId });
    expect(useToolStore.getState().viewMode).toBe('3d');
  });
  it('Modify lists the 2D sketch edits and arms them; Inspect opens the measure commands', () => {
    render(<Toolbar />);
    pick('Modify', 'Trim');
    expect(useToolStore.getState()).toMatchObject({ modifyTool: 'trim', viewMode: '2d' });
    expect(button('Select')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button('Select'));
    expect(useToolStore.getState().modifyTool).toBe('none');
    pick('Inspect', 'Distance');
    expect(usePaletteStore.getState().pendingCommand).toBe('measure_distance');
  });
  it('Undo and Redo are always in the bar, disabled until applicable', () => {
    render(<Toolbar />);
    expect(button('Undo')).toBeDisabled();
    expect(button('Redo')).toBeDisabled();
    pick('Solid', 'Box');
    expect(button('Undo')).toBeEnabled();
    expect(button('Redo')).toBeDisabled();
    fireEvent.click(button('Undo'));
    expect(useStore.getState().document.order).toHaveLength(0);
    expect(button('Undo')).toBeDisabled();
    expect(button('Redo')).toBeEnabled();
    fireEvent.click(button('Redo'));
    expect(useStore.getState().document.order).toHaveLength(1);
  });
});

describe('Selection bar', () => {
  beforeEach(() => {
    resetOfflineStore();
    usePaletteStore.setState({ open: false, pendingCommand: null, pendingParams: null });
    useFeatureSessionStore.getState().end();
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', modifyTool: 'none', gizmoMode: 'rotate', shortcutsOpen: false });
  });
  it('appears only while something is selected; in 3D Move / Rotate / Scale set the gizmo mode', () => {
    render(<Toolbar />);
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    pick('Solid', 'Box');
    expect(selectionBar()).toBeInTheDocument();
    fireEvent.click(button('Scale'));
    expect(useToolStore.getState().gizmoMode).toBe('scale');
    expect(button('Scale')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('Move'));
    expect(useToolStore.getState().gizmoMode).toBe('translate');
  });
  it('gives way to an open flyout and comes back when it closes', () => {
    render(<Toolbar />);
    pick('Solid', 'Box');
    fireEvent.click(button('Sketch'));
    expect(selectionBar()).toBeNull();
    fireEvent.click(button('Sketch'));
    expect(selectionBar()).toBeInTheDocument();
  });
  it('in 2D, Move arms the move tool and Rotate / Scale are disabled', () => {
    useToolStore.setState({ viewMode: '2d' });
    render(<Toolbar />);
    act(() => useStore.getState().dispatch('draw_polyline', { points: xy(0, 0, 1, 0) }));
    selectAll();
    expect(button('Rotate')).toBeDisabled();
    fireEvent.click(button('Move'));
    expect(useToolStore.getState().drawTool).toBe('move');
  });
  it('names the sole selected entity (or the count) and lets go of the selection', () => {
    render(<Toolbar />);
    pick('Solid', 'Box');
    expect(button('Clear selection')).toHaveTextContent('box');
    pick('Solid', 'Sphere');
    selectAll();
    expect(button('Clear selection')).toHaveTextContent('2 selected');
    fireEvent.click(button('Clear selection'));
    expect(useStore.getState().document.selection).toEqual([]);
    expect(selectionBar()).toBeNull();
  });
  it('offers what the selection can become: Fillet / Shell / Edit faces for a solid, Extrude for a sketch', () => {
    render(<Toolbar />);
    pick('Solid', 'Box');
    const features = (): string[] =>
      within(selectionBar() as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent ?? '')
        .filter((text) => ['Extrude', 'Fillet', 'Shell', 'Edit faces', 'Union', 'Subtract', 'Intersect'].includes(text));
    expect(features()).toEqual(['Fillet', 'Shell', 'Edit faces']);
    drawRectangle();
    expect(features()).toEqual(['Extrude']);
    selectAll();
    expect(features()).toEqual([]);
  });
  it('offers Union / Subtract / Intersect for several solids and opens the boolean form on them', () => {
    render(<Toolbar />);
    pick('Solid', 'Box');
    pick('Solid', 'Cylinder');
    selectAll();
    const [a, b] = useStore.getState().document.order;
    fireEvent.click(button('Union'));
    expect(usePaletteStore.getState()).toMatchObject({ open: true, pendingCommand: 'boolean', pendingParams: { op: 'union', a, b } });
  });
  it('Duplicate, Hide and Delete act on the selection; More opens the palette', () => {
    render(<Toolbar />);
    pick('Solid', 'Box');
    fireEvent.click(button('Duplicate'));
    expect(useStore.getState().document.order).toHaveLength(2);
    fireEvent.click(button('Delete'));
    expect(useStore.getState().document.order).toHaveLength(1);
    selectAll();
    fireEvent.click(button('More actions'));
    expect(usePaletteStore.getState().open).toBe(true);
    fireEvent.click(button('Hide'));
    expect(useStore.getState().document.selection).toEqual([]);
  });
});
