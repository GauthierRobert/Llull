/**
 * Component tests for the building-element inspector (Properties panel), the grid framing tools,
 * the slab "Grid extent" outline, labelled structural loads + warnings, and level edit / copy.
 * Param-gathering only: dispatch is spied, command math is unit-tested elsewhere.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

vi.mock('@core/commands/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/commands/registry')>();
  return {
    ...actual,
    execute: (...args: Parameters<typeof actual.execute>) => {
      const result = actual.execute(...args);
      return args[1] === 'check_portal_frames'
        ? { ...result, data: { rows: [], warnings: ['Frame F1: not analysed'] } }
        : result;
    },
  };
});

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
const submit = (): void => {
  fireEvent.click(screen.getByTestId('tool-submit'));
};

beforeEach(() => {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  localDispatch('add_level', {});
});

describe('building element inspector', () => {
  it('shows steel member facts and dispatches only the changed fields', () => {
    const { affected } = localDispatch('add_steel_member', {
      role: 'column',
      profile: 'HEB300',
      start: [0, 0, 0],
      end: [0, 0, 6000],
    });
    const memberEntity = affected.find((id) => id.endsWith(':body')) ?? affected[0]!;
    useStore.getState().select([memberEntity]);
    const dispatch = spyDispatch();
    render(<PropertiesPanel />);
    expect(screen.getByText(/HEB300/, { selector: '.props-number' })).toBeInTheDocument();
    expect(screen.getByText('6000 mm')).toBeInTheDocument();
    expect(screen.getByText('702 kg')).toBeInTheDocument();
    expect(screen.queryByText('Rotation°')).toBeNull();

    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'HEB320' } });
    fireEvent.click(screen.getByTestId('member-save'));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [name, params] = dispatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('update_steel_member');
    expect(params).toEqual({ memberId: expect.any(String), profile: 'HEB320' });
  });

  it('does not dispatch when nothing changed', () => {
    const { affected } = localDispatch('add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, 4000],
      end: [6000, 0, 4000],
    });
    useStore.getState().select([affected.find((id) => id.endsWith(':body')) ?? affected[0]!]);
    const dispatch = spyDispatch();
    render(<PropertiesPanel />);
    expect(screen.getByLabelText('Start joint')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('member-save'));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('edits equipment through update_equipment', () => {
    const { affected } = localDispatch('add_equipment', {
      name: 'Press',
      location: [0, 0],
      size: [2000, 2000, 2000],
    });
    useStore.getState().select([affected.find((id) => id.endsWith(':body')) ?? affected[0]!]);
    const dispatch = spyDispatch();
    render(<PropertiesPanel />);
    fireEvent.change(screen.getByTestId('equipment-edit-weight'), { target: { value: '1234' } });
    fireEvent.click(screen.getByTestId('equipment-save'));
    expect(dispatch).toHaveBeenCalledWith(
      'update_equipment',
      expect.objectContaining({ weight: 1234 }),
    );
  });
});

describe('grid framing tools', () => {
  it('lists the tools right after the structural grid', () => {
    render(<BuildingPanel />);
    const labels = Array.from(
      screen.getByTestId('building-tool-select').querySelectorAll('option'),
    ).map((option) => option.textContent);
    const gridIndex = labels.indexOf('Structural grid');
    expect(labels.slice(gridIndex, gridIndex + 4)).toEqual([
      'Structural grid',
      'Columns on grid',
      'Beams on grid',
      'Bracing on grid',
    ]);
  });

  it('dispatches add_grid_columns', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('gridColumns');
    setField('axes', 'A, B');
    setField('exclude', 'A/1');
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: '' } });
    submit();
    expect(dispatch).toHaveBeenLastCalledWith(
      'add_grid_columns',
      expect.objectContaining({
        profile: 'HEB300',
        axes: ['A', 'B'],
        exclude: ['A/1'],
        baseFixity: 'pinned',
      }),
    );
  });

  it('dispatches add_grid_beams with the top-of-steel offset', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('gridBeams');
    setField('topOffset', '-50');
    setField('startJoint', 'rigid');
    submit();
    expect(dispatch).toHaveBeenLastCalledWith(
      'add_grid_beams',
      expect.objectContaining({ profile: 'IPE300', topOffset: -50, startJoint: 'rigid' }),
    );
    expect(screen.getByLabelText(/Top of steel vs floor \(mm\)/)).toBeInTheDocument();
  });

  it('dispatches add_grid_bracing', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('gridBracing');
    setField('axis', 'A');
    setField('from', '1');
    setField('to', '2');
    setField('pattern', 'diagonal');
    submit();
    expect(dispatch).toHaveBeenLastCalledWith(
      'add_grid_bracing',
      expect.objectContaining({
        profile: 'CHS139.7x5',
        axis: 'A',
        from: '1',
        to: '2',
        pattern: 'diagonal',
      }),
    );
  });

  it('fills a slab rectangle from the grid extent', () => {
    localDispatch('add_grid_system', { xSpacings: [6000, 6000], ySpacings: [5000] });
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('slab');
    setField('source', 'grid');
    submit();
    const [name, params] = dispatch.mock.calls.at(-1) as [string, { boundary: number[][] }];
    expect(name).toBe('add_slab');
    expect(params.boundary).toHaveLength(4);
    const xs = params.boundary.map((point) => point[0]);
    expect(Math.max(...(xs as number[])) - Math.min(...(xs as number[]))).toBeGreaterThanOrEqual(
      12000,
    );
  });
});

describe('structural check section', () => {
  it('labels the load inputs and lists warnings', () => {
    localDispatch('add_portal_frame_building', { span: 18000, length: 12000, cladding: false });
    render(<BuildingPanel />);
    expect(screen.getByText('Roof dead load (kN/m²)')).toBeVisible();
    expect(screen.getByText('Snow load (kN/m²)')).toBeVisible();
    expect(screen.getByText('Wind pressure qp (kN/m²)')).toBeVisible();
    fireEvent.click(screen.getByTestId('frame-check'));
    expect(screen.getByRole('list', { name: 'Warnings' })).toHaveTextContent(
      'Frame F1: not analysed',
    );
  });
});

describe('levels: edit and copy', () => {
  it('dispatches update_level with only the changed fields', () => {
    const levelId = Object.keys(useStore.getState().document.building?.levels ?? {})[0]!;
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit level/ })[0]!);
    fireEvent.change(screen.getByLabelText('Level name'), { target: { value: 'Ground' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save level' }));
    expect(dispatch).toHaveBeenCalledWith('update_level', { levelId, name: 'Ground' });
  });

  it('dispatches copy_level_elements to the ticked levels and categories', () => {
    localDispatch('add_level', {});
    const levels = Object.keys(useStore.getState().document.building?.levels ?? {});
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    fireEvent.click(
      screen.getByRole('button', { name: `Copy level ${levelName(levels[0]!)} to levels` }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: levelName(levels[1]!) }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Columns' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy elements' }));
    expect(dispatch).toHaveBeenCalledWith('copy_level_elements', {
      sourceLevelId: levels[0],
      targetLevelIds: [levels[1]],
      categories: ['column'],
    });
  });
});

function levelName(levelId: string): string {
  return useStore.getState().document.building?.levels[levelId]?.name ?? levelId;
}
