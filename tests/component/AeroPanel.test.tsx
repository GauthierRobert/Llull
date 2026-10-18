import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutStore, useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';
import { useAeroViewStore } from '@ui/store/aeroViewStore';
import { AeroPanel } from '@ui/panels/aero/AeroPanel';
import { Sidebar } from '@ui/components/Sidebar';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

describe('AeroPanel', () => {
  beforeEach(() => {
    resetStore();
    useFocusStore.setState({ focus: null });
    useAeroViewStore.setState({ shown: true, body: null, airfoil: null });
  });
  afterEach(cleanup);

  it('asks for a solid when nothing is selected', () => {
    render(<AeroPanel />);
    expect(screen.getByText('No solid selected')).toBeDefined();
    expect(screen.queryByTestId('kpi-drag')).toBeNull();
  });

  it('shows the drag of the selected box and focuses it from the drag tile', () => {
    const box = localDispatch('add_box', { size: [2, 2, 2] }).affected[0] as string;
    act(() => useStore.getState().select([box]));
    render(<AeroPanel />);
    const tile = screen.getByTestId('kpi-drag');
    expect(tile.textContent).toMatch(/\d.* N/);
    expect(screen.getByTestId('kpi-area').textContent).toMatch(/m²/);
    expect(screen.getByTestId('aero-air').textContent).toMatch(/1\.22 kg\/m³/);
    expect(useAeroViewStore.getState().body?.dragN).toBeGreaterThan(0);
    fireEvent.click(tile);
    const focus = useFocusStore.getState().focus;
    expect(focus?.key).toBe('aero:drag');
    expect(focus?.entityIds).toEqual([box]);
    expect(focus?.markers[0]?.label).toMatch(/^D = /);
    expect(useStore.getState().document.selection).toEqual([box]);
  });

  it('measures every solid when "All solids" is ticked and clears the overlay on unmount', () => {
    localDispatch('add_box', { size: [2, 2, 2] });
    const { unmount } = render(<AeroPanel />);
    expect(screen.queryByTestId('kpi-drag')).toBeNull();
    fireEvent.click(screen.getByTestId('aero-all-solids'));
    expect(screen.getByTestId('kpi-drag')).toBeDefined();
    unmount();
    expect(useAeroViewStore.getState().body).toBeNull();
  });

  it('analyses a NACA code and a selected airfoil outline with Cl and a Cp legend', () => {
    render(<AeroPanel />);
    fireEvent.change(screen.getByTestId('aero-naca'), { target: { value: '2412' } });
    expect(screen.getByTestId('kpi-cl').textContent).toMatch(/Lift Cl/);
    expect(screen.queryByTestId('aero-legend')).toBeNull();
    cleanup();
    const outline = localDispatch('draw_naca_airfoil', { naca: '2412', chord: 10 }).affected[0] as string;
    act(() => useStore.getState().select([outline]));
    render(<AeroPanel />);
    expect(screen.getByTestId('aero-legend')).toBeDefined();
    expect(useAeroViewStore.getState().airfoil?.entityId).toBe(outline);
    fireEvent.click(screen.getByRole('button', { name: 'Show angle of attack 6°' }));
    expect(useFocusStore.getState().focus?.markers[0]?.label).toMatch(/^Cl = .* @ 6°$/);
    expect(useAeroViewStore.getState().airfoil?.alphaDeg).toBe(6);
  });
});

describe('Aerodynamics tab', () => {
  beforeEach(() => {
    resetStore();
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true, pinnedTabs: [] });
  });
  it('waits behind More panels until the document has solids, then joins the rail', () => {
    render(<Sidebar />);
    expect(screen.queryByRole('tab', { name: /^Aerodynamics/ })).toBeNull();
    act(() => void localDispatch('add_box', { size: [1, 1, 1] }));
    expect(screen.getByRole('tab', { name: /^Aerodynamics/ })).toBeDefined();
  });
});
