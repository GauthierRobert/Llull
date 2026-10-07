/**
 * Component tests for the Building panel forms an engineering office needs end to end:
 * project info on an empty document, slab material, equipment tag / level / editor, pipe line
 * list data, level-explicit placement and the export level picker (param-gathering → dispatch).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { downloadText } from '@ui/download';
import { localDispatch } from '../helpers/storeTestHelpers';

vi.mock('@ui/download', () => ({ downloadText: vi.fn(), downloadBlob: vi.fn() }));

function spyDispatch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  useStore.setState({ dispatch: spy } as unknown as Parameters<typeof useStore.setState>[0]);
  return spy;
}

const pickTool = (id: string): void => {
  fireEvent.change(screen.getByTestId('building-tool-select'), { target: { value: id } });
};
const setField = (key: string, value: string): void => {
  fireEvent.change(screen.getByTestId(`tool-field-${key}`), { target: { value } });
};

beforeEach(() => {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  vi.mocked(downloadText).mockClear();
});

describe('project information on an empty document', () => {
  it('is available before any building exists and dispatches only the changed fields', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    fireEvent.change(screen.getByTestId('project-name'), { target: { value: 'Pipe rack PR-1' } });
    fireEvent.change(screen.getByTestId('project-revision'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project info' }));
    expect(dispatch).toHaveBeenCalledWith('set_project_info', {
      name: 'Pipe rack PR-1',
      revision: 'A',
    });
  });
});

describe('level-explicit placement', () => {
  beforeEach(() => {
    localDispatch('add_level', { name: 'Ground' });
    localDispatch('add_level', { name: 'Upper', makeActive: false });
  });

  it('slab form carries a material and the chosen level', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('slab');
    setField('source', 'rectangle');
    setField('material', 'grating');
    setField('levelId', 'level-2');
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith('add_slab', {
      boundary: [
        [0, 0],
        [5000, 0],
        [5000, 4000],
        [0, 4000],
      ],
      thickness: 200,
      offset: 0,
      role: 'floor',
      material: 'grating',
      levelId: 'level-2',
    });
  });

  it('a blank level selector means the active level and a blank material is left out', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('slab');
    setField('source', 'rectangle');
    expect(
      within(screen.getByTestId('building-tools')).getByRole('option', { name: 'Active level' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tool-submit'));
    const params = dispatch.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('material');
    expect(params['levelId']).toBe('level-1');
  });

  it('equipment form carries the tag and the level', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('equipment');
    setField('mark', 'E-301');
    setField('name', 'Extractor');
    setField('weight', '62000');
    setField('levelId', 'level-2');
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith('add_equipment', {
      mark: 'E-301',
      name: 'Extractor',
      location: [6000, 6000],
      size: [3000, 2000, 2000],
      angle: 0,
      clearance: 800,
      weight: 62000,
      levelId: 'level-2',
    });
  });

  it.each([
    ['member', 'add_steel_member'],
    ['stair', 'add_stair'],
    ['pipe', 'add_pipe_run'],
    ['tray', 'add_cable_tray'],
  ])('%s form places on the chosen level', (tool, command) => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool(tool);
    setField('levelId', 'level-2');
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith(
      command,
      expect.objectContaining({ levelId: 'level-2' }),
    );
  });

  it('slab opening offers the stairs of every level', () => {
    localDispatch('add_stair', { levelId: 'level-2', start: [0, 0], angle: 0 });
    render(<BuildingPanel />);
    pickTool('slabOpening');
    expect(screen.getByRole('option', { name: /ST1 · \d+ risers · Upper/ })).toBeInTheDocument();
  });
});

describe('pipe run line list data', () => {
  it('gathers line number, DN, from and to; the outside diameter comes from the DN', () => {
    localDispatch('add_level', {});
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('pipe');
    setField('line', 'L-101');
    setField('dn', '200');
    setField('from', 'BL1-L-101');
    setField('to', 'E-301');
    setField('service', 'miscella');
    setField('points', '0,0,500; 6000,0,500');
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith('add_pipe_run', {
      points: [
        [0, 0, 500],
        [6000, 0, 500],
      ],
      line: 'L-101',
      dn: 200,
      from: 'BL1-L-101',
      to: 'E-301',
      service: 'miscella',
      levelId: 'level-1',
    });
  });

  it('an explicit outside diameter overrides the DN; neither is refused', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('pipe');
    setField('dn', '');
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a nominal size');
    expect(dispatch).not.toHaveBeenCalled();
    setField('diameter', '250');
    fireEvent.click(screen.getByTestId('tool-submit'));
    expect(dispatch).toHaveBeenLastCalledWith(
      'add_pipe_run',
      expect.objectContaining({ diameter: 250 }),
    );
  });
});

describe('equipment editor', () => {
  beforeEach(() => {
    localDispatch('add_level', { name: 'Ground' });
    localDispatch('add_level', { name: 'Upper', makeActive: false });
    localDispatch('add_equipment', {
      mark: 'E-301',
      name: 'Extractor',
      location: [6000, 6000],
      size: [12000, 4000, 9000],
      weight: 62000,
      clearance: 800,
    });
  });

  it('lists the equipment of every level and edits only what changed', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    expect(screen.queryByTestId('equipment-editor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit equipment E-301' }));
    expect(useStore.getState().document.selection).toEqual(['equipment-1:body']);
    const editor = screen.getByTestId('equipment-editor');
    expect(within(editor).getByTestId('equipment-edit-weight')).toHaveValue(62000);
    fireEvent.change(within(editor).getByTestId('equipment-edit-length'), {
      target: { value: '18000' },
    });
    fireEvent.change(within(editor).getByTestId('equipment-edit-weight'), {
      target: { value: '72000' },
    });
    fireEvent.click(screen.getByTestId('equipment-save'));
    expect(dispatch).toHaveBeenCalledWith('update_equipment', {
      elementId: 'equipment-1',
      size: [18000, 4000, 9000],
      weight: 72000,
    });
    fireEvent.change(within(editor).getByTestId('equipment-edit-shape'), {
      target: { value: 'vertical_vessel' },
    });
    fireEvent.click(screen.getByTestId('equipment-save'));
    expect(dispatch).toHaveBeenLastCalledWith(
      'update_equipment',
      expect.objectContaining({ elementId: 'equipment-1', shape: 'vertical_vessel' }),
    );
  });

  it('retags, renames, moves and rotates; refuses an empty edit and bad numbers', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit equipment E-301' }));
    fireEvent.click(screen.getByTestId('equipment-save'));
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing changed.');
    fireEvent.change(screen.getByTestId('equipment-edit-x'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('equipment-save'));
    expect(screen.getByRole('alert')).toHaveTextContent('Check: x');
    fireEvent.change(screen.getByTestId('equipment-edit-x'), { target: { value: '7000' } });
    fireEvent.change(screen.getByTestId('equipment-edit-mark'), { target: { value: 'E-310' } });
    fireEvent.change(screen.getByTestId('equipment-edit-name'), {
      target: { value: 'Extractor 2' },
    });
    fireEvent.change(screen.getByTestId('equipment-edit-angle'), { target: { value: '90' } });
    fireEvent.change(screen.getByTestId('equipment-edit-clearance'), { target: { value: '600' } });
    fireEvent.change(screen.getByTestId('equipment-edit-levelId'), {
      target: { value: 'level-2' },
    });
    fireEvent.click(screen.getByTestId('equipment-save'));
    expect(dispatch).toHaveBeenCalledWith('update_equipment', {
      elementId: 'equipment-1',
      mark: 'E-310',
      name: 'Extractor 2',
      location: [7000, 6000],
      angle: Math.PI / 2,
      clearance: 600,
      levelId: 'level-2',
    });
  });

  it('keeps the element id and tag across the update through the real command', () => {
    useStore.setState({
      dispatch: ((name: string, params: unknown) => localDispatch(name, params)) as ReturnType<
        typeof useStore.getState
      >['dispatch'],
    });
    render(<BuildingPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit equipment E-301' }));
    fireEvent.change(screen.getByTestId('equipment-edit-weight'), { target: { value: '72000' } });
    fireEvent.click(screen.getByTestId('equipment-save'));
    const equipment = useStore.getState().document.building?.elements['equipment-1'];
    expect(equipment).toMatchObject({ mark: 'E-301', weight: 72000 });
  });
});

describe('export level picker', () => {
  it('prints the chosen level without changing the active one', () => {
    localDispatch('add_level', { name: 'Ground' });
    localDispatch('add_level', { name: 'Upper', makeActive: false });
    localDispatch('add_wall', { start: [0, 0], end: [4000, 0], levelId: 'level-2' });
    render(<BuildingPanel />);
    fireEvent.change(screen.getByLabelText('Export level'), { target: { value: 'level-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan sheet' }));
    expect(screen.getByTestId('building-export-status')).toHaveTextContent(/level level-2 at 1:/);
    fireEvent.click(screen.getByRole('button', { name: 'DXF (AutoCAD)' }));
    expect(vi.mocked(downloadText).mock.calls.map(([, name]) => name)).toEqual([
      expect.stringMatching(/Upper.*1-/),
      expect.stringMatching(/Upper.*\.dxf$/),
    ]);
    expect(useStore.getState().document.building?.activeLevelId).toBe('level-1');
  });

  it('defaults to the active level', () => {
    localDispatch('add_level', { name: 'Ground' });
    localDispatch('add_level', { name: 'Upper', makeActive: false });
    render(<BuildingPanel />);
    expect(screen.getByLabelText('Export level')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Plan sheet' }));
    expect(screen.getByTestId('building-export-status')).toHaveTextContent(/level level-1 at 1:/);
  });
});

describe('steel members check', () => {
  it('runs the model-derived structural check and lists the worst members', () => {
    localDispatch('add_level', { name: 'Ground', height: 8000 });
    for (const x of [0, 6000]) {
      localDispatch('add_steel_member', {
        role: 'column',
        profile: 'HEB240',
        start: [x, 0, 0],
        end: [x, 0, 5000],
      });
    }
    localDispatch('add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, 4850],
      end: [6000, 0, 4850],
    });
    render(<BuildingPanel />);
    fireEvent.click(screen.getByTestId('steel-members-check'));
    expect(screen.getByTestId('frame-check-summary')).toHaveTextContent(/member/i);
    const rows = screen.getAllByTestId('frame-check-row');
    expect(rows).toHaveLength(3);
    fireEvent.click(rows[0]!);
    expect(useStore.getState().document.selection.length).toBeGreaterThan(0);
  });
});
