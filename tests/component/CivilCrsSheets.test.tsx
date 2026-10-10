/** Component tests: civil CRS + calibration form, plan sheet and plan-profile downloads. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { CivilPanel } from '@ui/panels/civil/CivilPanel';
import { downloadText } from '@ui/download';
import { localDispatch, spyDispatch } from '../helpers/storeTestHelpers';

vi.mock('@ui/download', () => ({ downloadText: vi.fn(), downloadBlob: vi.fn() }));

const SURVEY = ['1,0,0,10,TOPO', '2,20,0,11,TOPO', '3,0,20,12,TOPO', '4,20,20,13,TOPO'].join('\n');

beforeEach(() => {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  vi.mocked(downloadText).mockClear();
});

describe('CivilCrsSection', () => {
  it('dispatches set_coordinate_system and set_site_calibration', () => {
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('CRS name'), { target: { value: 'Lambert-93' } });
    fireEvent.change(screen.getByLabelText('EPSG code'), { target: { value: '2154' } });
    fireEvent.change(screen.getByLabelText('Vertical datum'), { target: { value: 'IGN69' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set CRS' }));
    expect(dispatch).toHaveBeenCalledWith('set_coordinate_system', {
      name: 'Lambert-93',
      epsg: 2154,
      verticalDatum: 'IGN69',
    });
    fireEvent.change(screen.getByLabelText('Local origin'), { target: { value: '0,0' } });
    fireEvent.change(screen.getByLabelText('Grid origin'), { target: { value: '1000, 2000' } });
    fireEvent.change(screen.getByLabelText('Rotation'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calibrate' }));
    expect(dispatch).toHaveBeenCalledWith('set_site_calibration', {
      localOrigin: [0, 0],
      gridOrigin: [1000, 2000],
      rotationDeg: 15,
    });
  });

  it('rejects a malformed origin locally and shows the current CRS', () => {
    const dispatch = spyDispatch();
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Local origin'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calibrate' }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByText(/each one "x, y" point/)).toBeInTheDocument();
  });

  it('displays the stored calibration', () => {
    localDispatch('set_coordinate_system', { name: 'Lambert-93', epsg: 2154 });
    localDispatch('set_site_calibration', { localOrigin: [0, 0], gridOrigin: [1, 2] });
    render(<CivilPanel />);
    expect(screen.getByTestId('civil-crs-current')).toHaveTextContent(
      'Lambert-93 (EPSG:2154) — calibrated',
    );
  });
});

describe('civil sheets downloads', () => {
  it('downloads the plan sheet with the chosen paper and scale', () => {
    localDispatch('set_units', { units: 'm' });
    localDispatch('import_survey_points', { text: SURVEY, name: 'Topo' });
    localDispatch('create_surface', {});
    render(<CivilPanel />);
    fireEvent.change(screen.getByLabelText('Sheet paper'), { target: { value: 'A2' } });
    fireEvent.change(screen.getByLabelText('Sheet scale'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan sheet' }));
    const [content, name, mime] = vi.mocked(downloadText).mock.calls[0] ?? [];
    expect(name).toBe('Untitled_project_civil_plan_A2_1-200.svg');
    expect(mime).toBe('image/svg+xml');
    expect(content).toContain('1:200');
  });

  it('downloads the plan-profile sheet from the alignment editor', () => {
    localDispatch('set_units', { units: 'm' });
    localDispatch('import_survey_points', { text: SURVEY, name: 'Topo' });
    localDispatch('create_surface', {});
    localDispatch('add_alignment', {
      points: [
        [2, 10],
        [18, 10],
      ],
      surfaceId: 'surface-1',
    });
    localDispatch('set_alignment_profile', {
      alignmentId: 'alignment-1',
      pvis: [
        { station: 0, elevation: 11 },
        { station: 16, elevation: 12 },
      ],
    });
    render(<CivilPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Plan-profile sheet' }));
    expect(vi.mocked(downloadText).mock.calls[0]?.[1]).toMatch(/_plan_profile_A3_1-\d+\.svg$/);
  });
});
