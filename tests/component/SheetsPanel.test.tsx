import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { SheetsPanel } from '@ui/panels/SheetsPanel';
import { useSheetViewStore } from '@ui/viewport/sheet/sheetViewStore';
import { localDispatch, spyDispatch } from '../helpers/storeTestHelpers';

function reset(): void {
  useStore.getState().setDocument(createEmptyDocument());
  useSheetViewStore.setState({ openSheetId: null, selectedViewId: null, showDimensions: false });
}

function sheetWithViews(): { sheetId: string; viewId: string } {
  localDispatch('add_box', { size: [10, 20, 30] });
  const { affected } = localDispatch('create_sheet', { name: 'Bracket', views: ['front', 'top'] });
  return { sheetId: affected[0]!, viewId: affected[1]! };
}

describe('SheetsPanel', () => {
  beforeEach(reset);

  it('shows an empty state without sheets', () => {
    render(<SheetsPanel />);
    expect(screen.getByText('No sheets yet')).toBeTruthy();
  });

  it('create dispatches create_sheet with the form values and default front/top/right views', () => {
    const spy = spyDispatch();
    render(<SheetsPanel />);
    fireEvent.change(screen.getByTestId('sheet-new-name'), { target: { value: 'Plate' } });
    fireEvent.change(screen.getByTestId('sheet-new-paper'), { target: { value: 'A4' } });
    fireEvent.change(screen.getByTestId('sheet-new-projection'), { target: { value: 'third' } });
    fireEvent.change(screen.getByTestId('sheet-new-title'), { target: { value: 'Base plate' } });
    fireEvent.click(screen.getByTestId('sheet-create'));
    expect(spy).toHaveBeenCalledWith('create_sheet', {
      name: 'Plate',
      paper: 'A4',
      projectionAngle: 'third',
      title: 'Base plate',
      views: ['front', 'top', 'right'],
    });
  });

  it('toggling a standard view changes the requested views', () => {
    const spy = spyDispatch();
    render(<SheetsPanel />);
    fireEvent.click(screen.getByLabelText('Isometric'));
    fireEvent.click(screen.getByLabelText('Top'));
    fireEvent.click(screen.getByTestId('sheet-create'));
    expect(spy).toHaveBeenCalledWith('create_sheet', expect.objectContaining({ views: ['front', 'right', 'iso'] }));
  });

  it('lists sheets and opens one in the viewer state', () => {
    const { sheetId } = sheetWithViews();
    render(<SheetsPanel />);
    fireEvent.click(screen.getByTestId(`sheet-open-${sheetId}`));
    expect(useSheetViewStore.getState().openSheetId).toBe(sheetId);
    expect(screen.getByTestId(`sheet-view-row-${useStore.getState().document.drawings!.sheets[sheetId]!.views[0]!.id}`)).toBeTruthy();
  });

  it('delete asks for confirmation, then dispatches delete_sheet and closes the viewer', () => {
    const { sheetId } = sheetWithViews();
    useSheetViewStore.getState().openSheet(sheetId);
    const spy = spyDispatch();
    render(<SheetsPanel />);
    fireEvent.click(screen.getByTestId(`sheet-delete-${sheetId}`));
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete'));
    expect(spy).toHaveBeenCalledWith('delete_sheet', { sheetId });
    expect(useSheetViewStore.getState().openSheetId).toBeNull();
  });

  it('view commands carry the sheet id and form values', () => {
    const { sheetId, viewId } = sheetWithViews();
    useSheetViewStore.getState().openSheet(sheetId);
    const spy = spyDispatch();
    render(<SheetsPanel />);

    fireEvent.change(screen.getByTestId('sheet-view-direction'), { target: { value: 'iso' } });
    fireEvent.click(screen.getByTestId('sheet-add-view'));
    expect(spy).toHaveBeenCalledWith('create_drawing_view', { sheetId, direction: 'iso' });

    fireEvent.change(screen.getByTestId('sheet-section-offset'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByTestId('sheet-section-parent'), { target: { value: viewId } });
    fireEvent.click(screen.getByTestId('sheet-add-section'));
    expect(spy).toHaveBeenCalledWith('add_section_view', { sheetId, direction: 'right', offset: 2.5, parentViewId: viewId });

    fireEvent.change(screen.getByTestId('sheet-detail-radius'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('sheet-detail-scale'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByTestId('sheet-add-detail'));
    expect(spy).toHaveBeenCalledWith('add_detail_view', { sheetId, parentViewId: viewId, center: [0, 0], radius: 4, scale: 0.5 });

    fireEvent.click(screen.getByTestId(`sheet-view-delete-${viewId}`));
    expect(spy).toHaveBeenCalledWith('delete_drawing_view', { sheetId, viewId });
  });

  it('rejects a non-numeric section offset inline without dispatching', () => {
    const { sheetId } = sheetWithViews();
    useSheetViewStore.getState().openSheet(sheetId);
    const spy = spyDispatch();
    render(<SheetsPanel />);
    fireEvent.change(screen.getByTestId('sheet-section-offset'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('sheet-add-section'));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Offset');
  });

  it('update sends the edited name and title block', () => {
    const { sheetId } = sheetWithViews();
    useSheetViewStore.getState().openSheet(sheetId);
    const spy = spyDispatch();
    render(<SheetsPanel />);
    fireEvent.change(screen.getByTestId('sheet-edit-name'), { target: { value: 'Bracket v2' } });
    fireEvent.change(screen.getByTestId('sheet-edit-revision'), { target: { value: 'B' } });
    fireEvent.click(screen.getByTestId('sheet-update'));
    expect(spy).toHaveBeenCalledWith(
      'update_sheet',
      expect.objectContaining({ sheetId, name: 'Bracket v2', revision: 'B', paper: 'A3', projectionAngle: 'first' }),
    );
  });

  it('clicking a view row selects it', () => {
    const { sheetId, viewId } = sheetWithViews();
    useSheetViewStore.getState().openSheet(sheetId);
    render(<SheetsPanel />);
    fireEvent.click(screen.getByTestId(`sheet-view-select-${viewId}`));
    expect(useSheetViewStore.getState().selectedViewId).toBe(viewId);
  });
});
