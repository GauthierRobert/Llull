import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as localQuery from '@ui/services/localQuery';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { SheetViewer } from '@ui/viewport/sheet/SheetViewer';
import { useSheetViewStore } from '@ui/viewport/sheet/sheetViewStore';
import { fitTransform, readSheetExport, viewAtPaperPoint } from '@ui/viewport/sheet/sheetData';
import { runQuery } from '@ui/services/localQuery';
import { localDispatch } from '../helpers/storeTestHelpers';

function reset(): void {
  useStore.getState().setDocument(createEmptyDocument());
  useSheetViewStore.setState({ openSheetId: null, selectedViewId: null, showDimensions: false });
}

function openSheet(params: Record<string, unknown> = {}): string {
  localDispatch('add_box', { size: [10, 20, 30] });
  const sheetId = localDispatch('create_sheet', { name: 'Bracket', views: ['front', 'top', 'right'], ...params }).affected[0]!;
  useSheetViewStore.getState().openSheet(sheetId);
  return sheetId;
}

const imageSrc = (): string => decodeURIComponent((screen.getByTestId('sheet-image') as HTMLImageElement).src);

describe('SheetViewer', () => {
  beforeEach(reset);

  it('renders nothing while no sheet is open', () => {
    const { container } = render(<SheetViewer />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the sheet SVG as an image with the paper size and scale', () => {
    openSheet();
    render(<SheetViewer />);
    expect(imageSrc()).toContain('<svg');
    expect(screen.getByTestId('sheet-scale').textContent).toContain('A3');
    expect(screen.queryByTestId('sheet-fits-warning')).toBeNull();
  });

  it('warns when the views overflow the sheet', () => {
    openSheet({ scale: 0.01 });
    render(<SheetViewer />);
    expect(screen.getByTestId('sheet-fits-warning')).toBeTruthy();
  });

  it('lists export warnings as text when present and nothing when absent', () => {
    const sheetId = openSheet();
    const real = runQuery('export_sheet_svg', { sheetId });
    const spy = vi.spyOn(localQuery, 'runQuery');
    spy.mockReturnValue({ ...real, data: { ...(real.data as object), warnings: ['front: detail circle contains no geometry'] } });
    const { unmount } = render(<SheetViewer />);
    expect(screen.getByTestId('sheet-warnings').textContent).toContain('1 warning');
    expect(screen.getByLabelText('Sheet warnings').textContent).toContain('Warning: front: detail circle contains no geometry');
    unmount();
    spy.mockReturnValue({ ...real, data: { ...(real.data as object), warnings: [] } });
    render(<SheetViewer />);
    expect(screen.queryByTestId('sheet-warnings')).toBeNull();
    spy.mockRestore();
  });

  it('the Dimensions toggle re-exports with showDimensions', () => {
    openSheet();
    render(<SheetViewer />);
    const before = imageSrc();
    fireEvent.click(screen.getByLabelText('Dimensions'));
    expect(useSheetViewStore.getState().showDimensions).toBe(true);
    expect(imageSrc()).not.toBe(before);
  });

  it('re-renders the drawing when the model changes', () => {
    openSheet();
    render(<SheetViewer />);
    const before = imageSrc();
    act(() => void localDispatch('add_box', { size: [50, 5, 5] }));
    expect(imageSrc()).not.toBe(before);
  });

  it('clicking a view selects it and clicking bare paper clears it', () => {
    const sheetId = openSheet();
    render(<SheetViewer />);
    const data = readSheetExport(runQuery('export_sheet_svg', { sheetId }).data)!;
    const target = data.views[0]!;
    const { x, y, k } = fitTransform(900, 600, data.widthMm, data.heightMm);
    const [minX, minY, maxX, maxY] = target.bounds;
    const stage = screen.getByTestId('sheet-stage');
    const click = (paperX: number, paperY: number): void => {
      const point = { clientX: x + paperX * k, clientY: y + paperY * k, pointerId: 1 };
      fireEvent.pointerDown(stage, point);
      fireEvent.pointerUp(stage, point);
    };
    click((minX + maxX) / 2, (minY + maxY) / 2);
    expect(viewAtPaperPoint(data.views, (minX + maxX) / 2, (minY + maxY) / 2)).toBe(useSheetViewStore.getState().selectedViewId);
    expect(screen.getByTestId('sheet-selection')).toBeTruthy();
    click(0.5, 0.5);
    expect(useSheetViewStore.getState().selectedViewId).toBeNull();
  });

  it('Model button closes the viewer; a deleted sheet closes it too', () => {
    const sheetId = openSheet();
    render(<SheetViewer />);
    fireEvent.click(screen.getByTestId('sheet-close'));
    expect(screen.queryByTestId('sheet-viewer')).toBeNull();
    act(() => useSheetViewStore.getState().openSheet(sheetId));
    expect(screen.getByTestId('sheet-viewer')).toBeTruthy();
    act(() => void localDispatch('delete_sheet', { sheetId }));
    expect(screen.queryByTestId('sheet-viewer')).toBeNull();
    expect(useSheetViewStore.getState().openSheetId).toBeNull();
  });
});
