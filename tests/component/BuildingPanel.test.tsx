/**
 * Component tests for <BuildingPanel /> — param-gathering → dispatch (react R11).
 * Geometry/quantity math is unit-tested in tests/unit/building.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

function spyDispatch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  useStore.setState({ dispatch: spy } as unknown as Parameters<typeof useStore.setState>[0]);
  return spy;
}

beforeEach(() => {
  __resetIdCounter();
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
});

describe('BuildingPanel', () => {
  it('shows the empty state and dispatches starter templates and zoom extents', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    expect(screen.getByText('No building yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Starter house' }));
    fireEvent.click(screen.getByRole('button', { name: 'Starter office' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom extents' }));
    expect(dispatch.mock.calls).toEqual([
      ['add_building_template', { template: 'house' }],
      ['add_building_template', { template: 'office' }],
      ['fit_view', { direction: 'iso' }],
    ]);
  });

  it('adds a level with name and height', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    fireEvent.change(screen.getByLabelText('New level name'), { target: { value: 'Basement' } });
    fireEvent.change(screen.getByLabelText('New level height'), { target: { value: '2600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    expect(dispatch).toHaveBeenCalledWith('add_level', { name: 'Basement', height: 2600 });
  });

  it('lists levels and elements of the active level, with activate / select / delete', () => {
    localDispatch('add_level', { name: 'Ground' });
    localDispatch('add_level', { name: 'Upper', makeActive: false });
    localDispatch('add_wall', { start: [0, 0], end: [4000, 0] });
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    expect(screen.getByTestId('level-row-level-1')).toHaveAttribute('aria-current', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Activate level Upper' }));
    expect(dispatch).toHaveBeenCalledWith('set_active_level', { levelId: 'level-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Select Wall W1' }));
    expect(useStore.getState().document.selection).toEqual(['wall-1:body-0']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Wall W1' }));
    expect(dispatch).toHaveBeenCalledWith('delete_building_element', { elementIds: ['wall-1'] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete level Upper' }));
    expect(dispatch).toHaveBeenCalledWith('delete_level', {
      levelId: 'level-2',
      deleteElements: true,
    });
  });

  it('element tools gather params and dispatch one command; invalid input shows an error', () => {
    localDispatch('add_level', {});
    localDispatch('add_wall', { start: [0, 0], end: [4000, 0] });
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith('add_grid_system', {
      xSpacings: [6000, 6000],
      ySpacings: [5000],
    });

    fireEvent.change(screen.getByTestId('building-tool-select'), { target: { value: 'door' } });
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a host wall first.');
    fireEvent.change(screen.getByTestId('tool-field-wallId'), { target: { value: 'wall-1' } });
    fireEvent.change(screen.getByTestId('tool-field-offset'), { target: { value: '1200' } });
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith('add_door', {
      wallId: 'wall-1',
      offset: 1200,
      width: 900,
      height: 2100,
      swing: 'left',
    });

    fireEvent.change(screen.getByTestId('building-tool-select'), { target: { value: 'column' } });
    fireEvent.click(screen.getByTestId('tool-field-atGrid'));
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith('add_column', {
      atGridIntersections: true,
      shape: 'rectangular',
      width: 300,
      levelId: 'level-1',
    });

    fireEvent.change(screen.getByTestId('building-tool-select'), { target: { value: 'wall' } });
    fireEvent.change(screen.getByTestId('tool-field-x1'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Check: x1');
  });

  it('saves project info changes only', () => {
    localDispatch('add_level', {});
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    const save = screen.getByRole('button', { name: 'Save project info' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('project-client'), { target: { value: 'ACME' } });
    fireEvent.click(save);
    expect(dispatch).toHaveBeenCalledWith('set_project_info', { client: 'ACME' });
  });

  it('shows the live takeoff and sets a unit rate', () => {
    localDispatch('add_wall', { start: [0, 0], end: [5000, 0] });
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    expect(screen.getByTestId('takeoff-wall.concrete.m3')).toHaveTextContent('3 m³');
    expect(screen.getByTestId('estimate-total')).toHaveTextContent('0.00 EUR');
    fireEvent.change(screen.getByTestId('rate-key'), { target: { value: 'wall.concrete.m3' } });
    fireEvent.change(screen.getByTestId('rate-value'), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set rate' }));
    expect(dispatch).toHaveBeenCalledWith('set_cost_rates', { rates: { 'wall.concrete.m3': 180 } });
  });

  it('export buttons report the exporter summary', () => {
    localDispatch('add_wall', { start: [0, 0], end: [5000, 0] });
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(<BuildingPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'DXF (AutoCAD)' }));
    expect(screen.getByTestId('building-export-status')).toHaveTextContent(/^DXF /);
    fireEvent.click(screen.getByRole('button', { name: 'IFC (BIM)' }));
    expect(screen.getByTestId('building-export-status')).toHaveTextContent(/^IFC4 /);
    fireEvent.click(screen.getByRole('button', { name: 'Plan sheet' }));
    expect(screen.getByTestId('building-export-status')).toHaveTextContent(/Plan sheet .* on A3/);
    expect(createObjectURL).toHaveBeenCalledTimes(3);
    expect(click).toHaveBeenCalledTimes(3);
    click.mockRestore();
  });

  it('generates a steel hall and picks industrial tools from their group', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Steel hall' }));
    expect(dispatch).toHaveBeenCalledWith('add_portal_frame_building', {});
    expect(screen.getByRole('group', { name: 'Industrial / steel' })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('building-tool-select'), { target: { value: 'pipe' } });
    fireEvent.change(screen.getByTestId('tool-field-service'), { target: { value: 'steam' } });
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith('add_pipe_run', {
      points: [
        [2000, 3000, 4000],
        [20000, 3000, 4000],
      ],
      diameter: 114.3,
      service: 'steam',
    });
  });

  it('runs the clash check and selects a clashing pair', () => {
    localDispatch('add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [0, 0, 0],
      end: [0, 0, 6000],
    });
    localDispatch('add_equipment', { name: 'Press', location: [0, 0], size: [2000, 2000, 2000] });
    render(<BuildingPanel />);
    fireEvent.click(screen.getByTestId('clash-check'));
    expect(screen.getByTestId('clash-summary')).toHaveTextContent('1 hard, 0 clearance');
    expect(screen.getByTestId('clash-row')).toHaveTextContent(/EQ1 × SC1/);
    fireEvent.click(screen.getByTestId('clash-row'));
    expect(useStore.getState().document.selection).toEqual(['equipment-1:body', 'member-1:body']);
  });

  it('reports a clean model and exports an elevation and a section', () => {
    localDispatch('add_box', { position: [0, 0, 500], size: [2000, 1000, 1000] });
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(<BuildingPanel />);
    fireEvent.click(screen.getByTestId('clash-check'));
    expect(screen.getByTestId('clash-summary')).toHaveTextContent('No clashes found.');
    fireEvent.change(screen.getByLabelText('Elevation direction'), { target: { value: 'east' } });
    fireEvent.click(screen.getByRole('button', { name: 'Elevation sheet' }));
    expect(screen.getByTestId('building-export-status')).toHaveTextContent(
      /East_elevation.*visible face/,
    );
    fireEvent.change(screen.getByLabelText('Section cut position'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide cladding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Section sheet' }));
    expect(screen.getByTestId('building-export-status')).toHaveTextContent(/Section_at_x_0/);
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });
});
