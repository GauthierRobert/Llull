import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { createEmptyDocument } from '@core/model/types';
import { useLayoutStore, usePaletteStore, useStore, useToolStore, useViewportStore } from '@ui/store';
import { ViewportContextMenu } from '@ui/components/ViewportContextMenu';

function Harness(): React.ReactElement {
  return (
    <main className="app-viewport" data-testid="host">
      <ViewportContextMenu />
    </main>
  );
}

function rightClick(host: HTMLElement, from: [number, number], to: [number, number] = from): void {
  fireEvent.pointerDown(host, { button: 2, clientX: from[0], clientY: from[1] });
  fireEvent.pointerUp(host, { button: 2, clientX: to[0], clientY: to[1] });
}

describe('ViewportContextMenu', () => {
  const dispatch = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', gizmoMode: 'translate' });
    useViewportStore.setState({ hiddenEntityIds: new Set<string>() });
    useStore.setState({ document: { ...createEmptyDocument(), order: ['a', 'b'], selection: ['a'] }, dispatch });
  });

  it('opens on a right click and closes on Escape', () => {
    const { getByTestId } = render(<Harness />);
    rightClick(getByTestId('host'), [40, 40]);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not open after a right-drag, and suppresses the native menu', () => {
    const { getByTestId } = render(<Harness />);
    rightClick(getByTestId('host'), [40, 40], [90, 60]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(fireEvent.contextMenu(getByTestId('host'))).toBe(false);
  });

  it('selection items dispatch commands and viewport actions', () => {
    const { getByTestId } = render(<Harness />);
    rightClick(getByTestId('host'), [10, 10]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(dispatch).toHaveBeenCalledWith('delete_entities', { ids: ['a'] });
    expect(screen.queryByRole('menu')).toBeNull();

    rightClick(getByTestId('host'), [10, 10]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Rotate/ }));
    expect(useToolStore.getState().gizmoMode).toBe('rotate');

    rightClick(getByTestId('host'), [10, 10]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Isolate/ }));
    expect([...useViewportStore.getState().hiddenEntityIds]).toEqual(['b']);
  });

  it('Show all is disabled until something is hidden; 2D offers only Move', () => {
    const { getByTestId } = render(<Harness />);
    useToolStore.setState({ viewMode: '2d' });
    rightClick(getByTestId('host'), [10, 10]);
    expect((screen.getByRole('menuitem', { name: /Show all/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('menuitem', { name: /Rotate/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Move/ }));
    expect(useToolStore.getState().drawTool).toBe('move');
  });

  it('without a selection offers solids and the command palette', () => {
    useStore.setState({ document: { ...createEmptyDocument(), selection: [] } });
    const { getByTestId } = render(<Harness />);
    rightClick(getByTestId('host'), [10, 10]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Add box/ }));
    expect(dispatch).toHaveBeenCalledWith('add_box', expect.anything(), { selectAffected: true });
    rightClick(getByTestId('host'), [10, 10]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Search commands/ }));
    expect(usePaletteStore.getState().open).toBe(true);
    usePaletteStore.getState().setOpen(false);
  });

  it('Properties toggles the inspector; arrow keys move focus', () => {
    const before = useLayoutStore.getState().inspectorOpen;
    const { getByTestId } = render(<Harness />);
    rightClick(getByTestId('host'), [10, 10]);
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Properties/ }));
    expect(useLayoutStore.getState().inspectorOpen).toBe(!before);
  });
});
