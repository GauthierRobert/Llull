import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { CivilPanel, downloadText, localDispatch, spyDispatch, setupCivilStore, SURVEY, surveyed } from '../helpers/civilPanel';
import { xy } from '../helpers/xy';

vi.mock('@ui/download', () => ({ downloadText: vi.fn(), downloadBlob: vi.fn() }));

setupCivilStore();

describe('CivilPanel', () => {
  it('shows the empty state and imports survey text with format and unit', () => {
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    expect(screen.getByText('No site data yet')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Survey points text'), { target: { value: SURVEY } });
    fireEvent.change(screen.getByLabelText('Survey format'), { target: { value: 'PNEZD' } });
    fireEvent.change(screen.getByLabelText('Survey unit'), { target: { value: 'mm' } });
    fireEvent.change(screen.getByLabelText('Point group name'), { target: { value: 'Topo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import points' }));
    expect(dispatch).toHaveBeenCalledWith('import_survey_points', { text: SURVEY, format: 'PNEZD', sourceUnit: 'mm', name: 'Topo' });
  });
  it('lists the imported point group and the surface report', () => {
    localDispatch('import_survey_points', { text: SURVEY, name: 'Topo' });
    const { rerender } = render(<CivilPanel />);
    expect(screen.getByTestId('civil-row-pointGroup-1')).toHaveTextContent('Topo');
    expect(screen.getByTestId('civil-row-pointGroup-1')).toHaveTextContent('4 points');
    act(() => {
      localDispatch('create_surface', {});
    });
    rerender(<CivilPanel />);
    expect(screen.getByTestId('civil-row-surface-1')).toHaveTextContent(/4 points, 2 triangles/);
  });
  it('creates a surface and edits its contour interval', () => {
    surveyed();
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Contour interval'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create surface' }));
    expect(dispatch).toHaveBeenCalledWith('create_surface', { contourInterval: 0.5 });
    fireEvent.change(screen.getByLabelText(/^Contour interval of/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set interval' }));
    expect(dispatch).toHaveBeenCalledWith('update_surface', { surfaceId: 'surface-1', contourInterval: 2 });
    fireEvent.click(screen.getByRole('button', { name: /^Delete EG/ }));
    expect(dispatch).toHaveBeenCalledWith('delete_civil_object', { id: 'surface-1' });
  });
  it('adds a platform from the typed outline and refuses a bad outline', () => {
    surveyed();
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Platform outline'), { target: { value: '1,1; 5' } });
    fireEvent.change(screen.getByLabelText('Platform elevation'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add platform' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/at least 3 points/);
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Platform outline'), { target: { value: '5,5; 15,5; 15,15; 5,15' } });
    fireEvent.change(screen.getByLabelText('Cut slope'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add platform' }));
    expect(dispatch).toHaveBeenCalledWith('add_platform', {
      surfaceId: 'surface-1',
      boundary: xy(5, 5, 15, 5, 15, 15, 5, 15),
      elevation: 11,
      cutSlope: 1,
    });
  });
  it('takes a platform outline from the selected polyline', () => {
    surveyed();
    localDispatch('draw_polyline', { points: xy(2, 2, 8, 2, 8, 8), closed: true });
    const id = useStore.getState().document.order.at(-1) ?? '';
    useStore.setState({ document: { ...useStore.getState().document, selection: [id] } });
    render(<CivilPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: 'From selection' })[0] as HTMLElement);
    expect(screen.getByLabelText('Platform outline')).toHaveValue('2,2; 8,2; 8,8');
  });
  it('adds an alignment and a manhole with the expected params', () => {
    surveyed();
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Alignment points'), { target: { value: '0,0; 10,5; 20,0' } });
    fireEvent.change(screen.getByLabelText('Curve radii'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add alignment' }));
    expect(dispatch).toHaveBeenCalledWith('add_alignment', { points: xy(0, 0, 10, 5, 20, 0), radii: [15] });
    fireEvent.change(screen.getByLabelText('Manhole position'), { target: { value: '4,4' } });
    fireEvent.change(screen.getByLabelText('Manhole invert'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Manhole surface'), { target: { value: 'surface-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add manhole' }));
    expect(dispatch).toHaveBeenCalledWith('add_manhole', { location: [4, 4], invertElevation: 9, surfaceId: 'surface-1' });
  });
  it('downloads the LandXML and DXF exports', () => {
    surveyed();
    render(<CivilPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'LandXML' }));
    fireEvent.click(screen.getByRole('button', { name: 'DXF (civil)' }));
    const calls = vi.mocked(downloadText).mock.calls;
    expect(calls.map(([, name, mime]) => [name, mime])).toEqual([
      ['Untitled_project.xml', 'application/xml'],
      ['Untitled_project_civil.dxf', 'application/dxf'],
    ]);
    expect(calls[0]?.[0]).toContain('<LandXML');
    expect(screen.getByTestId('civil-export-status')).toHaveTextContent(/^DXF /);
  });
});
