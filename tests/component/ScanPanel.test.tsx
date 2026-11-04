import { resetStore } from '../helpers/componentEntities';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useLayoutStore, useStore } from '@ui/store';
import { useScanViewStore } from '@ui/store/scanViewStore';
import { ScanPanel } from '@ui/panels/scan/ScanPanel';
import { Sidebar } from '@ui/components/Sidebar';
import { localDispatch } from '../helpers/storeTestHelpers';

const ASSET = 'a'.repeat(64);

function attachCloud(): string {
  const result = localDispatch('attach_point_cloud', { assetKey: ASSET, name: 'Unit 4 scan' });
  const id = result.affected[0];
  if (id === undefined) throw new Error(`attach failed: ${result.summary}`);
  return id;
}

describe('ScanPanel', () => {
  beforeEach(() => {
    resetStore();
  });

  it('offers to attach a cloud when there is none', () => {
    render(<ScanPanel />);
    expect(screen.getByText('No point cloud attached')).toBeDefined();
    expect(screen.queryByTestId('scan-colour')).toBeNull();
  });

  it('lists the attached clouds with their streaming report', () => {
    const id = attachCloud();
    render(<ScanPanel />);
    expect(screen.getByText('Unit 4 scan')).toBeDefined();
    expect(screen.getByTestId(`scan-points-${id}`).textContent).toContain('0 / —');
    act(() => {
      useScanViewStore
        .getState()
        .reportStream(id, {
          status: 'ready',
          message: '',
          pointCount: 2_500_000,
          drawn: 640_000,
          tilesResident: 12,
          tilesVisible: 9,
          modes: ['elevation', 'single'],
        });
    });
    expect(screen.getByTestId(`scan-points-${id}`).textContent).toContain('640,000 / 2,500,000');
    expect(screen.getByTestId(`scan-status-${id}`).textContent).toBe('Streaming');
  });

  it('says so when the backend is not there instead of failing silently', () => {
    const id = attachCloud();
    useScanViewStore
      .getState()
      .reportStream(id, {
        status: 'offline',
        message: 'Point data is served by the llull backend (desktop app).',
        pointCount: null,
        drawn: 0,
        tilesResident: 0,
        tilesVisible: 0,
        modes: ['elevation', 'single'],
      });
    render(<ScanPanel />);
    expect(screen.getByText(/served by the llull backend/)).toBeDefined();
  });

  it('marks the colour modes the loaded data cannot show', () => {
    const id = attachCloud();
    useScanViewStore
      .getState()
      .reportStream(id, {
        status: 'ready',
        message: '',
        pointCount: 10,
        drawn: 10,
        tilesResident: 1,
        tilesVisible: 1,
        modes: ['elevation', 'single'],
      });
    render(<ScanPanel />);
    const select = screen.getByTestId('scan-colour');
    expect(within(select).getByRole('option', { name: 'Elevation' })).toBeDefined();
    expect(within(select).getByRole('option', { name: 'Intensity (no data)' })).toBeDefined();
  });

  it('changes only the UI state: colour, budget, crops and snap, never the document', () => {
    attachCloud();
    const before = useStore.getState().document;
    render(<ScanPanel />);
    fireEvent.change(screen.getByTestId('scan-colour'), { target: { value: 'single' } });
    fireEvent.change(screen.getByTestId('scan-budget'), { target: { value: '3000000' } });
    fireEvent.click(screen.getByTestId('scan-crops'));
    fireEvent.click(screen.getByTestId('scan-snap'));
    expect(useScanViewStore.getState().edl).toBe(true);
    fireEvent.click(screen.getByTestId('scan-edl'));
    expect(useScanViewStore.getState()).toMatchObject({
      colourChoice: 'single',
      pointBudget: 3_000_000,
      applyCrops: false,
      snapToScan: false,
      edl: false,
    });
    expect(useStore.getState().document).toBe(before);
  });

  it('counts the document crop boxes in the crop toggle', () => {
    attachCloud();
    localDispatch('set_scan_crop', { name: 'tie-in', min: [0, 0, 0], max: [5, 5, 5] });
    render(<ScanPanel />);
    expect(screen.getByText(/Apply crop boxes \(1\)/)).toBeDefined();
  });
});

describe('Scan tab', () => {
  beforeEach(() => {
    resetStore();
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true, pinnedTabs: [] });
  });

  it('joins the rail once a cloud is attached', () => {
    const { unmount } = render(<Sidebar />);
    expect(screen.queryByRole('tab', { name: /^Scan/ })).toBeNull();
    unmount();
    attachCloud();
    render(<Sidebar />);
    expect(screen.getByRole('tab', { name: /^Scan, 1/ })).toBeDefined();
  });
});
