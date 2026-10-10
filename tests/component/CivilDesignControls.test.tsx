/**
 * Component tests for the Civil / Site panel design controls a pilot tutorial uses (react R11):
 * clothoid spiral lengths on a new alignment, superelevation and the plan-profile paper on an
 * alignment, and the IDF design storm + outfall tailwater of the drainage check and sizing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { CivilPanel } from '@ui/panels/civil/CivilPanel';
import { downloadText } from '@ui/download';
import { localDispatch, spyDispatch } from '../helpers/storeTestHelpers';

vi.mock('@ui/download', () => ({ downloadText: vi.fn(), downloadBlob: vi.fn() }));

const SURVEY = ['1,0,0,10', '2,100,0,11', '3,0,100,12', '4,100,100,13'].join('\n');

function site(): void {
  localDispatch('set_units', { units: 'm' });
  localDispatch('import_survey_points', { text: SURVEY, name: 'Topo' });
  localDispatch('create_surface', {});
  localDispatch('add_alignment', {
    name: 'Road',
    points: [
      [10, 10],
      [90, 10],
      [90, 90],
    ],
    radii: [30],
    surfaceId: 'surface-1',
  });
  localDispatch('set_alignment_profile', {
    alignmentId: 'alignment-1',
    pvis: [
      { station: 0, elevation: 10.5 },
      { station: 100, elevation: 12 },
    ],
  });
  localDispatch('add_manhole', { location: [20, 50], invertElevation: 9, surfaceId: 'surface-1' });
  localDispatch('add_manhole', {
    location: [60, 50],
    invertElevation: 8.5,
    surfaceId: 'surface-1',
  });
  localDispatch('add_pipe', { fromId: 'manhole-1', toId: 'manhole-2' });
}

beforeEach(() => {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  vi.mocked(downloadText).mockClear();
});

describe('Civil design controls', () => {
  it('adds an alignment with clothoid spiral lengths and refuses a malformed list', () => {
    site();
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Alignment points'), {
      target: { value: '0,0; 50,10; 60,60' },
    });
    fireEvent.change(screen.getByLabelText('Curve radii'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Spiral lengths'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add alignment' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Spirals/);
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Spiral lengths'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add alignment' }));
    expect(dispatch).toHaveBeenCalledWith(
      'add_alignment',
      expect.objectContaining({ radii: [40], spirals: [20] }),
    );
  });

  it('sets the superelevation of an alignment and explains a blank rate', () => {
    site();
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Set superelevation' }));
    expect(screen.getByTestId('civil-alignment-status-alignment-1')).toHaveTextContent(/ratio/);
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Superelevation of Road'), {
      target: { value: '0.06' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set superelevation' }));
    expect(dispatch).toHaveBeenCalledWith('set_superelevation', {
      alignmentId: 'alignment-1',
      maxRate: 0.06,
    });
  });

  it('issues the plan-profile sheet on the chosen paper', () => {
    site();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Sheet paper of Road'), { target: { value: 'A2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan-profile sheet' }));
    const [content, name] = vi.mocked(downloadText).mock.calls[0] ?? [];
    expect(name).toMatch(/_A2_/);
    expect(content).toContain('<svg');
  });

  it('checks and sizes the network with an IDF curve and the outfall tailwater', () => {
    site();
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('IDF a'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('IDF b'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('IDF c'), { target: { value: '0.8' } });
    fireEvent.change(screen.getByLabelText('Outfall level'), { target: { value: '8.6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check network' }));
    expect(screen.getByTestId('civil-drainage-status')).toHaveTextContent(
      /IDF i=1000\/\(t\+10\)\^0.8 mm\/h/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Size pipes' }));
    expect(dispatch).toHaveBeenCalledWith('size_drainage_pipes', {
      idf: { a: 1000, b: 10, c: 0.8 },
    });
  });

  it('falls back to the constant intensity while the IDF curve is incomplete', () => {
    site();
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Rainfall intensity'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('IDF a'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Size pipes' }));
    expect(dispatch).toHaveBeenCalledWith('size_drainage_pipes', { rainfallIntensityMmH: 80 });
  });
});

describe('Civil document unit', () => {
  it('offers to switch a millimetre document to metres, and hides once in metres', () => {
    useStore.setState({ document: { ...createEmptyDocument(), units: 'mm' } });
    const dispatch = spyDispatch();
    const { unmount } = render(<CivilPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Work in metres' }));
    expect(dispatch).toHaveBeenCalledWith('set_units', { units: 'm' });
    unmount();
    useStore.setState({ document: { ...createEmptyDocument(), units: 'm' } });
    render(<CivilPanel />);
    expect(screen.queryByRole('button', { name: 'Work in metres' })).toBeNull();
  });
});
