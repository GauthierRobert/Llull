/**
 * Component tests for the steel member form (roll, joints, base fixity), the Pipe support form and
 * the pipe-support check (param-gathering → dispatch; the command math is unit-tested elsewhere).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { localDispatch, spyDispatch } from '../helpers/storeTestHelpers';
import { shoeDoc } from '../unit/building/pipeSupportFixtures';
import { pickTool, setField, submit } from '../helpers/buildingForm';

const supportCount = (): number =>
  Object.values(useStore.getState().document.building?.elements ?? {}).filter(
    (element) => element.category === 'pipeSupport',
  ).length;

beforeEach(() => {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
});

describe('steel member form: roll, joints, base fixity', () => {
  beforeEach(() => {
    localDispatch('add_level', {});
  });

  it('converts roll degrees to radians and sends rigid joints for a beam', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('member');
    setField('role', 'beam');
    setField('roll', '90');
    setField('startJoint', 'rigid');
    setField('endJoint', 'rigid');
    submit();
    expect(dispatch).toHaveBeenLastCalledWith(
      'add_steel_member',
      expect.objectContaining({
        role: 'beam',
        roll: Math.PI / 2,
        startJoint: 'rigid',
        endJoint: 'rigid',
      }),
    );
    expect(dispatch.mock.lastCall?.[1]).not.toHaveProperty('baseFixity');
  });

  it('shows joints only for beams and base fixity only for columns', () => {
    render(<BuildingPanel />);
    pickTool('member');
    expect(screen.getByTestId('tool-field-startJoint')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-field-baseFixity')).toBeNull();
    setField('role', 'column');
    expect(screen.queryByTestId('tool-field-startJoint')).toBeNull();
    expect(screen.getByTestId('tool-field-baseFixity')).toBeInTheDocument();
    setField('role', 'brace');
    expect(screen.queryByTestId('tool-field-endJoint')).toBeNull();
    expect(screen.queryByTestId('tool-field-baseFixity')).toBeNull();
  });

  it('sends the base fixity of a column and drops joints chosen before switching role', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('member');
    setField('startJoint', 'rigid');
    setField('role', 'column');
    setField('baseFixity', 'fixed');
    submit();
    const params = dispatch.mock.lastCall?.[1] as Record<string, unknown>;
    expect(params).toMatchObject({ role: 'column', baseFixity: 'fixed' });
    expect(params).not.toHaveProperty('startJoint');
  });

  it('leaves joints and fixity to the command defaults when blank', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('member');
    submit();
    const params = dispatch.mock.lastCall?.[1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('startJoint');
    expect(params).not.toHaveProperty('endJoint');
  });
});

describe('pipe support form', () => {
  beforeEach(() => {
    useStore.setState({ document: shoeDoc() });
  });

  it('offers the pipes by line number', () => {
    render(<BuildingPanel />);
    pickTool('pipeSupport');
    const select = screen.getByTestId('tool-field-pipe');
    expect(select).toHaveTextContent('L-1');
    expect(select).toHaveTextContent('DN100');
  });

  it('dispatches add_pipe_support with absolute points for the chosen line', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('pipeSupport');
    setField('pipe', 'line:L-1');
    setField('type', 'hanger');
    setField('points', '1000,2000,3000; 3000,2000,3000');
    setField('memberId', 'member-3');
    setField('maxReach', '1500');
    submit();
    expect(dispatch).toHaveBeenLastCalledWith('add_pipe_support', {
      line: 'L-1',
      type: 'hanger',
      at: [
        [1000, 2000, 3000],
        [3000, 2000, 3000],
      ],
      memberId: 'member-3',
      maxReach: 1500,
    });
  });

  it('dispatches a spacing instead of points', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('pipeSupport');
    setField('pipe', 'line:L-1');
    setField('spacing', '3000');
    submit();
    expect(dispatch).toHaveBeenLastCalledWith('add_pipe_support', {
      line: 'L-1',
      type: 'shoe',
      spacing: 3000,
    });
  });

  it('refuses no pipe, neither points nor spacing, or both', () => {
    const dispatch = spyDispatch();
    render(<BuildingPanel />);
    pickTool('pipeSupport');
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the pipe');
    setField('pipe', 'line:L-1');
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('either the support points or');
    setField('points', '1,2,3');
    setField('spacing', '3000');
    submit();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('end to end: the form adds a support the check then counts', () => {
    useStore.setState({
      dispatch: (name: string, params?: unknown) => void localDispatch(name, params),
    } as unknown as Parameters<typeof useStore.setState>[0]);
    render(<BuildingPanel />);
    pickTool('pipeSupport');
    setField('pipe', 'line:L-1');
    setField('points', '3000,2000,3027.15');
    submit();
    expect(supportCount()).toBe(1);
    fireEvent.click(screen.getByTestId('pipe-support-check'));
    const rows = screen.getAllByTestId('frame-check-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('L-1');
    expect(rows[0]).toHaveTextContent(/span [\d.]+ \/ [\d.]+ m/);
  });
});
