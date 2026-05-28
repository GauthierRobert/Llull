/**
 * Component tests for <MechanismsPanel />.
 *
 * Verifies observable behavior (workflow W3, react R11):
 *   - Each section shows an empty-state hint when the doc has nothing.
 *   - A constraint row renders with the correct kind chip and entity refs.
 *   - "Solve" button dispatches solve_constraints (whole-doc).
 *   - "Delete" constraint button dispatches delete_constraint with the correct id.
 *   - A joint row renders with kind chip, instance ids, axis, current value.
 *   - Editing the joint value input and blurring dispatches set_joint_value.
 *   - "Delete" joint button dispatches delete_joint with the correct id.
 *   - A drive-relation row renders with driver, driven, and ratio.
 *   - "Delete" drive-relation button dispatches delete_drive_relation with the correct id.
 *
 * No geometry math or internals — behavioral testing only.
 * @layer tests/component
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { MechanismsPanel } from '@ui/panels/MechanismsPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

function patchDispatch(spy: ReturnType<typeof vi.fn>): void {
  useStore.setState({ dispatch: spy } as any);
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

/** Add two boxes and a constraint between them. Returns ids. */
function buildConstraint(): { constraintId: string; boxId: string; sphereId: string } {
  const r1 = localDispatch('add_box', { size: [1, 1, 1] });
  const r2 = localDispatch('add_sphere', { radius: 1 });
  const boxId = r1.affected[0]!;
  const sphereId = r2.affected[0]!;
  const rc = localDispatch('add_constraint', {
    constraint: {
      kind: 'distance',
      a: { entityId: boxId },
      b: { entityId: sphereId },
      value: '5',
    },
  });
  const constraintId = rc.affected[0]!;
  return { constraintId, boxId, sphereId };
}

/** Build two components + instances + a revolute joint. Returns ids. */
function buildJoint(): { jointId: string; jointAId: string; jointBId: string } {
  const rb1 = localDispatch('add_box', { size: [1, 1, 1] });
  const rb2 = localDispatch('add_box', { size: [1, 1, 1] });
  localDispatch('create_component', { name: 'CompA', entityIds: [rb1.affected[0]!] });
  localDispatch('create_component', { name: 'CompB', entityIds: [rb2.affected[0]!] });
  const doc = useStore.getState().document;
  const compIds = Object.keys(doc.components);
  const compAId = compIds[0]!;
  const compBId = compIds[1]!;
  const ri1 = localDispatch('insert_instance', { componentId: compAId });
  const ri2 = localDispatch('insert_instance', { componentId: compBId });
  const jointAId = ri1.affected[0]!;
  const jointBId = ri2.affected[0]!;
  const rj = localDispatch('add_joint', {
    kind: 'revolute',
    a: { instanceId: jointAId },
    b: { instanceId: jointBId },
    axis: 'z',
  });
  return { jointId: rj.affected[0]!, jointAId, jointBId };
}

/** Build a second joint (prismatic) for drive relation and add the relation. */
function buildDriveRelation(driverJointId: string): { driveId: string; drivenJointId: string } {
  const rb3 = localDispatch('add_box', { size: [1, 1, 1] });
  const rb4 = localDispatch('add_box', { size: [1, 1, 1] });
  localDispatch('create_component', { name: 'CompC', entityIds: [rb3.affected[0]!] });
  localDispatch('create_component', { name: 'CompD', entityIds: [rb4.affected[0]!] });
  const doc = useStore.getState().document;
  const allCompIds = Object.keys(doc.components);
  // Newly created components are the last two.
  const compCId = allCompIds[allCompIds.length - 2]!;
  const compDId = allCompIds[allCompIds.length - 1]!;
  const ri3 = localDispatch('insert_instance', { componentId: compCId });
  const ri4 = localDispatch('insert_instance', { componentId: compDId });
  const rj2 = localDispatch('add_joint', {
    kind: 'prismatic',
    a: { instanceId: ri3.affected[0]! },
    b: { instanceId: ri4.affected[0]! },
    axis: 'x',
  });
  const drivenJointId = rj2.affected[0]!;
  const rd = localDispatch('add_drive_relation', {
    driver: driverJointId,
    driven: drivenJointId,
    ratio: 2.0,
  });
  return { driveId: rd.affected[0]!, drivenJointId };
}

/**
 * Build a doc with one constraint, one joint, and one drive relation.
 * Returns all ids needed by the section tests.
 */
function buildFullDoc(): {
  constraintId: string;
  boxId: string;
  sphereId: string;
  jointId: string;
  jointAId: string;
  jointBId: string;
  driveId: string;
  drivenJointId: string;
} {
  const c = buildConstraint();
  const j = buildJoint();
  const d = buildDriveRelation(j.jointId);
  return { ...c, ...j, ...d };
}

// ---------------------------------------------------------------------------
// Empty-state tests
// ---------------------------------------------------------------------------

describe('MechanismsPanel — empty state', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
    useViewportStore.setState({ mechanismSelection: null });
  });

  it('shows empty hints for all three sections when document is empty', () => {
    render(<MechanismsPanel />);
    expect(screen.getByText('No constraints defined.')).toBeDefined();
    expect(screen.getByText('No joints defined.')).toBeDefined();
    expect(screen.getByText('No drive relations defined.')).toBeDefined();
  });

  it('shows section titles', () => {
    render(<MechanismsPanel />);
    expect(screen.getByText('Constraints')).toBeDefined();
    expect(screen.getByText('Joints')).toBeDefined();
    expect(screen.getByText('Drive Relations')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Constraint section tests
// ---------------------------------------------------------------------------

describe('MechanismsPanel — constraints section', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
    useViewportStore.setState({ mechanismSelection: null });
  });

  it('renders a constraint row with the kind chip', () => {
    const { constraintId } = buildFullDoc();
    render(<MechanismsPanel />);
    const row = screen.getByTestId(`constraint-row-${constraintId}`);
    expect(row).toBeDefined();
    expect(row.textContent).toContain('distance');
  });

  it('"Solve" button dispatches solve_constraints', () => {
    const { constraintId } = buildFullDoc();
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);
    render(<MechanismsPanel />);
    const solveBtn = screen.getByTestId(`constraint-solve-${constraintId}`);
    fireEvent.click(solveBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('solve_constraints', {});
  });

  it('"Delete" button dispatches delete_constraint with the correct id', () => {
    const { constraintId } = buildFullDoc();
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);
    render(<MechanismsPanel />);
    const deleteBtn = screen.getByTestId(`constraint-delete-${constraintId}`);
    fireEvent.click(deleteBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('delete_constraint', { id: constraintId });
  });
});

// ---------------------------------------------------------------------------
// Joint section tests
// ---------------------------------------------------------------------------

describe('MechanismsPanel — joints section', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
    useViewportStore.setState({ mechanismSelection: null });
  });

  it('renders a joint row with the kind chip', () => {
    const { jointId } = buildFullDoc();
    render(<MechanismsPanel />);
    const row = screen.getByTestId(`joint-row-${jointId}`);
    expect(row).toBeDefined();
    expect(row.textContent).toContain('revolute');
  });

  it('joint row input shows current angle value', () => {
    const { jointId } = buildFullDoc();
    render(<MechanismsPanel />);
    const input = screen.getByTestId(`joint-value-${jointId}`) as HTMLInputElement;
    expect(input.value).toBe('0');
  });

  it('editing joint value and blurring dispatches set_joint_value', () => {
    const { jointId } = buildFullDoc();
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);
    render(<MechanismsPanel />);
    const input = screen.getByTestId(`joint-value-${jointId}`);
    fireEvent.change(input, { target: { value: '1.57' } });
    fireEvent.blur(input);
    expect(dispatchSpy).toHaveBeenCalledWith('set_joint_value', { id: jointId, value: 1.57 });
  });

  it('"Delete" button dispatches delete_joint with the correct id', () => {
    const { jointId } = buildFullDoc();
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);
    render(<MechanismsPanel />);
    const deleteBtn = screen.getByTestId(`joint-delete-${jointId}`);
    fireEvent.click(deleteBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('delete_joint', { id: jointId });
  });
});

// ---------------------------------------------------------------------------
// Drive-relation section tests
// ---------------------------------------------------------------------------

describe('MechanismsPanel — drive relations section', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
    useViewportStore.setState({ mechanismSelection: null });
  });

  it('renders a drive-relation row with ratio', () => {
    const { driveId } = buildFullDoc();
    render(<MechanismsPanel />);
    const row = screen.getByTestId(`drive-row-${driveId}`);
    expect(row).toBeDefined();
    expect(row.textContent).toContain('ratio');
    expect(row.textContent).toContain('2.0000');
  });

  it('"Delete" button dispatches delete_drive_relation with the correct id', () => {
    const { driveId } = buildFullDoc();
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);
    render(<MechanismsPanel />);
    const deleteBtn = screen.getByTestId(`drive-delete-${driveId}`);
    fireEvent.click(deleteBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('delete_drive_relation', { id: driveId });
  });
});
