/**
 * @layer ui/panels
 *
 * MechanismsPanel — constraints, joints, and drive-relations inspector.
 *
 * Three collapsible sections:
 *   A — Constraints: kind chip, referenced entity ids, value for dimensional kinds,
 *       "Solve" button (dispatches solve_constraints), "Delete" button (delete_constraint).
 *   B — Joints: kind chip, instance ids, axis, current value, numeric input for
 *       set_joint_value, "Delete" button (delete_joint).
 *   C — Drive Relations: driver→driven, ratio, offset, "Delete" button (delete_drive_relation).
 *
 * Selecting a row highlights it in `mechanismSelection` (viewport-store UI state) so
 * `MechanismOverlay` can draw a visual cue in the 3D viewport.
 *
 * Pure presentation — no document mutations except through store.dispatch (PRIME DIRECTIVE).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import type { Constraint, Joint, DriveRelation } from '@core/model/types';
import { PanelEmpty, PanelHeader, PanelSection, IconButton } from '@ui/panels/PanelParts';

type ChipTone = 'accent' | 'success' | 'warning' | 'danger' | 'agent';

const CONSTRAINT_CHIP_TONE: Record<string, ChipTone> = {
  coincident: 'accent',
  parallel: 'success',
  perpendicular: 'warning',
  tangent: 'agent',
  distance: 'danger',
  angle: 'accent',
};

const JOINT_CHIP_TONE: Record<string, ChipTone> = {
  revolute: 'accent',
  prismatic: 'agent',
};

/** Format an EntityRef for display: "entityId[:kind]". */
function fmtEntityRef(ref: Constraint['a'] | Constraint['b']): string {
  const shortId = ref.entityId.slice(-6);
  if ('kind' in ref && ref.kind) return `${shortId}:${ref.kind}`;
  return shortId;
}

interface ConstraintRowProps {
  constraint: Constraint;
  highlighted: boolean;
  onHighlight: (id: string) => void;
}

function ConstraintRow({
  constraint,
  highlighted,
  onHighlight,
}: ConstraintRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const chipTone = CONSTRAINT_CHIP_TONE[constraint.kind] ?? 'accent';
  const aRef = fmtEntityRef(constraint.a);
  const bRef = fmtEntityRef(constraint.b);

  const value =
    'value' in constraint && constraint.value !== undefined
      ? ` = ${typeof constraint.value === 'number' ? constraint.value.toFixed(3) : String(constraint.value)}`
      : '';

  return (
    <li
      className={`panel__row mechanisms-row${highlighted ? ' panel__row--selected mechanisms-row--highlighted' : ''}`}
      data-testid={`constraint-row-${constraint.id}`}
      onClick={() => onHighlight(constraint.id)}
      aria-selected={highlighted}
      role="option"
    >
      <span className={`chip chip--${chipTone}`}>{constraint.kind}</span>
      <span className="panel__row-main mechanisms-row-info">
        {aRef} → {bRef}
        {value}
      </span>
      <div className="panel__row-actions">
        <IconButton
          icon="zap"
          testId={`constraint-solve-${constraint.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch('solve_constraints', {});
          }}
          title="Solve all constraints"
          label="Solve constraints"
        />
        <IconButton
          icon="trash"
          danger
          testId={`constraint-delete-${constraint.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch('delete_constraint', { id: constraint.id });
          }}
          title="Delete this constraint"
          label={`Delete constraint ${constraint.id}`}
        />
      </div>
    </li>
  );
}

interface JointRowProps {
  joint: Joint;
  highlighted: boolean;
  onHighlight: (id: string) => void;
}

function JointRow({ joint, highlighted, onHighlight }: JointRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const currentValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
  const [inputValue, setInputValue] = useState<string>(String(currentValue));

  const commitInput = (): void => {
    const parsed = parseFloat(inputValue);
    if (isNaN(parsed)) setInputValue(String(currentValue));
    else dispatch('set_joint_value', { id: joint.id, value: parsed });
  };

  const chipTone = JOINT_CHIP_TONE[joint.kind] ?? 'accent';
  const axisLabel = Array.isArray(joint.axis)
    ? `[${(joint.axis as number[]).join(',')}]`
    : joint.axis;
  const unit = joint.kind === 'revolute' ? 'rad' : 'mm';

  return (
    <li
      className={`panel__row mechanisms-row${highlighted ? ' panel__row--selected mechanisms-row--highlighted' : ''}`}
      data-testid={`joint-row-${joint.id}`}
      onClick={() => onHighlight(joint.id)}
      aria-selected={highlighted}
      role="option"
    >
      <span className={`chip chip--${chipTone}`}>{joint.kind}</span>
      <span className="panel__row-main mechanisms-row-info">
        {joint.a.instanceId.slice(-6)} → {joint.b.instanceId.slice(-6)} · axis {axisLabel}
      </span>
      <input
        type="number"
        className="mechanisms-joint-input"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commitInput}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitInput();
          else if (e.key === 'Escape') setInputValue(String(currentValue));
        }}
        aria-label={`Joint value for ${joint.id} (${unit})`}
        data-testid={`joint-value-${joint.id}`}
        title={`Current ${joint.kind === 'revolute' ? 'angle' : 'displacement'} in ${unit}`}
        onClick={(e) => e.stopPropagation()}
      />
      <span className="panel__row-meta">{unit}</span>
      <div className="panel__row-actions">
        <IconButton
          icon="trash"
          danger
          testId={`joint-delete-${joint.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch('delete_joint', { id: joint.id });
          }}
          title="Delete this joint"
          label={`Delete joint ${joint.id}`}
        />
      </div>
    </li>
  );
}

interface DriveRelationRowProps {
  relation: DriveRelation;
}

function DriveRelationRow({ relation }: DriveRelationRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const offsetLabel =
    relation.offset !== undefined && relation.offset !== 0
      ? ` + ${relation.offset.toFixed(3)}`
      : '';

  return (
    <li className="panel__row mechanisms-row" data-testid={`drive-row-${relation.id}`}>
      <span className="panel__row-main mechanisms-row-info">
        <strong>{relation.driver.slice(-6)}</strong>
        {' → '}
        <strong>{relation.driven.slice(-6)}</strong>
        {' · ratio '}
        <span className="mechanisms-ratio">{relation.ratio.toFixed(4)}</span>
        {offsetLabel}
      </span>
      <div className="panel__row-actions">
        <IconButton
          icon="trash"
          danger
          testId={`drive-delete-${relation.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch('delete_drive_relation', { id: relation.id });
          }}
          title="Delete this drive relation"
          label={`Delete drive relation ${relation.id}`}
        />
      </div>
    </li>
  );
}

interface MechanismsPanelProps {
  className?: string;
}

export function MechanismsPanel({ className }: MechanismsPanelProps): React.ReactElement {
  const constraints = useStore((s) => s.document.constraints);
  const constraintOrder = useStore((s) => s.document.constraintOrder);
  const joints = useStore((s) => s.document.joints);
  const jointOrder = useStore((s) => s.document.jointOrder);
  const driveRelations = useStore((s) => s.document.driveRelations);
  const driveRelationOrder = useStore((s) => s.document.driveRelationOrder);

  const mechanismSelection = useViewportStore((s) => s.mechanismSelection);
  const setMechanismSelection = useViewportStore((s) => s.setMechanismSelection);

  const isHighlighted = (kind: 'constraint' | 'joint', id: string): boolean =>
    mechanismSelection?.kind === kind && mechanismSelection.id === id;
  const highlight =
    (kind: 'constraint' | 'joint') =>
    (id: string): void =>
      setMechanismSelection(isHighlighted(kind, id) ? null : { kind, id });

  const constraintList = constraintOrder
    .map((id) => constraints[id])
    .filter((c): c is Constraint => c !== undefined);
  const jointList = jointOrder.map((id) => joints[id]).filter((j): j is Joint => j !== undefined);
  const driveList = driveRelationOrder
    .map((id) => driveRelations[id])
    .filter((d): d is DriveRelation => d !== undefined);

  return (
    <aside
      className={['panel mechanisms-panel', className].filter(Boolean).join(' ')}
      aria-label="Mechanisms"
    >
      <PanelHeader title="Mechanisms" />
      <PanelSection
        collapsible
        title="Constraints"
        count={constraintList.length}
        countLabel={`${constraintList.length} constraints`}
        testId="mechanisms-section-constraints"
      >
        {constraintList.length === 0 ? (
          <PanelEmpty compact icon="mechanism" message="No constraints defined." />
        ) : (
          <ul className="panel__list" aria-label="Constraint list" role="listbox">
            {constraintList.map((c) => (
              <ConstraintRow
                key={c.id}
                constraint={c}
                highlighted={isHighlighted('constraint', c.id)}
                onHighlight={highlight('constraint')}
              />
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        collapsible
        title="Joints"
        count={jointList.length}
        countLabel={`${jointList.length} joints`}
        testId="mechanisms-section-joints"
      >
        {jointList.length === 0 ? (
          <PanelEmpty compact icon="mechanism" message="No joints defined." />
        ) : (
          <ul className="panel__list" aria-label="Joint list" role="listbox">
            {jointList.map((j) => (
              <JointRow
                key={j.id}
                joint={j}
                highlighted={isHighlighted('joint', j.id)}
                onHighlight={highlight('joint')}
              />
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        collapsible
        title="Drive Relations"
        count={driveList.length}
        countLabel={`${driveList.length} drive relations`}
        testId="mechanisms-section-drive relations"
      >
        {driveList.length === 0 ? (
          <PanelEmpty compact icon="mechanism" message="No drive relations defined." />
        ) : (
          <ul className="panel__list" aria-label="Drive relation list" role="list">
            {driveList.map((d) => (
              <DriveRelationRow key={d.id} relation={d} />
            ))}
          </ul>
        )}
      </PanelSection>
    </aside>
  );
}
