// Constraints (solve/delete), joints (set value/delete), drive relations (delete) and rigid-body physics (PhysicsSection); a highlighted constraint/joint
// row sets `mechanismSelection` for MechanismOverlay.

import { toDegrees, toRadians } from '@lib/angle';
import React from 'react';
import { classNames } from '@ui/classNames';
import { useStore, useViewportStore } from '@ui/store';
import type { Constraint, Joint, DriveRelation } from '@core/model/types';
import { PanelEmpty, PanelHeader, PanelSection, IconButton, DeleteButton } from '@ui/panels/PanelParts';
import { CommitInput } from '@ui/panels/propertyFields';
import { orderedValues } from '@ui/panels/orderedValues';
import { parseNumber } from '@ui/numberText';
import { PhysicsSection } from '@ui/panels/PhysicsSection';
import { PhysicsLoadsSection } from '@ui/panels/PhysicsLoadsSection';

type ChipTone = 'accent' | 'success' | 'warning' | 'danger' | 'agent';

const CONSTRAINT_CHIP_TONE: Record<string, ChipTone> = {
  coincident: 'accent',
  parallel: 'success',
  perpendicular: 'warning',
  tangent: 'agent',
  distance: 'danger',
  angle: 'accent',
};

const JOINT_CHIP_TONE: Record<string, ChipTone> = { revolute: 'accent', prismatic: 'agent' };

const MECHANISM_ACTIONS = [
  { label: 'Add constraint', command: 'add_constraint' },
  { label: 'Add joint', command: 'add_joint' },
  { label: 'Add drive', command: 'add_drive_relation' },
  { label: 'Add rigid body', command: 'add_rigid_body' },
] as const;

const mechanismRowClass = (highlighted: boolean): string =>
  classNames('panel__row panel__row--overlay-actions mechanisms-row', highlighted && 'panel__row--selected mechanisms-row--highlighted');

/** "entityId[:kind]" (last 6 id chars). */
function fmtEntityRef(ref: Constraint['a'] | Constraint['b']): string {
  const shortId = ref.entityId.slice(-6);
  if ('kind' in ref && ref.kind) return `${shortId}:${ref.kind}`;
  return shortId;
}

interface MechanismRowProps {
  noun: 'constraint' | 'joint' | 'drive';
  id: string;
  /** Chip text and tone; omitted = no chip. */
  kind?: string;
  tone?: ChipTone;
  highlighted?: boolean;
  /** Omitted = the row cannot be highlighted in the viewport (no eye button). */
  onHighlight?: (id: string) => void;
  info: React.ReactNode;
  /** Controls between the info text and the action buttons. */
  inline?: React.ReactNode;
  actions: React.ReactNode;
}

function MechanismRow({
  noun,
  id,
  kind,
  tone = 'accent',
  highlighted = false,
  onHighlight,
  info,
  inline,
  actions,
}: MechanismRowProps): React.ReactElement {
  return (
    <li className={mechanismRowClass(highlighted)} data-testid={`${noun}-row-${id}`}>
      {kind !== undefined && <span className={`chip chip--${tone}`}>{kind}</span>}
      <span className="panel__row-main mechanisms-row-info">{info}</span>
      {inline}
      <div className="panel__row-actions">
        {onHighlight !== undefined && (
          <IconButton
            icon="eye"
            testId={`${noun}-highlight-${id}`}
            pressed={highlighted}
            onClick={() => onHighlight(id)}
            title="Highlight in the viewport"
            label={`Highlight ${noun} ${id}`}
          />
        )}
        {actions}
      </div>
    </li>
  );
}

function ConstraintRow({
  constraint,
  highlighted,
  onHighlight,
}: {
  constraint: Constraint;
  highlighted: boolean;
  onHighlight: (id: string) => void;
}): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const chipTone = CONSTRAINT_CHIP_TONE[constraint.kind] ?? 'accent';
  const aRef = fmtEntityRef(constraint.a);
  const bRef = fmtEntityRef(constraint.b);

  const value =
    'value' in constraint && constraint.value !== undefined
      ? ` = ${typeof constraint.value === 'number' ? constraint.value.toFixed(3) : String(constraint.value)}`
      : '';

  return (
    <MechanismRow
      noun="constraint"
      id={constraint.id}
      kind={constraint.kind}
      tone={chipTone}
      highlighted={highlighted}
      onHighlight={onHighlight}
      info={
        <>
          {aRef} → {bRef}
          {value}
        </>
      }
      actions={
        <>
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
          <DeleteButton
            testId={`constraint-delete-${constraint.id}`}
            onDelete={() => dispatch('delete_constraint', { id: constraint.id })}
            title="Delete this constraint"
            label={`Delete constraint ${constraint.id}`}
          />
        </>
      }
    />
  );
}

function JointRow({
  joint,
  highlighted,
  onHighlight,
}: {
  joint: Joint;
  highlighted: boolean;
  onHighlight: (id: string) => void;
}): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const documentUnits = useStore((s) => s.document.units);
  const revolute = joint.kind === 'revolute';
  // Revolute angles shown in degrees (like Properties); the command takes radians.
  const currentValue = revolute ? toDegrees(joint.angle, 6) : joint.displacement;

  const commitInput = (text: string): void => {
    const parsed = parseNumber(text);
    if (parsed !== undefined && parsed !== currentValue) {
      dispatch('set_joint_value', { id: joint.id, value: revolute ? toRadians(parsed) : parsed });
    }
  };

  const chipTone = JOINT_CHIP_TONE[joint.kind] ?? 'accent';
  const axisLabel = Array.isArray(joint.axis) ? `[${joint.axis.join(',')}]` : joint.axis;
  const unit = revolute ? '°' : documentUnits;

  return (
    <MechanismRow
      noun="joint"
      id={joint.id}
      kind={joint.kind}
      tone={chipTone}
      highlighted={highlighted}
      onHighlight={onHighlight}
      info={`${joint.a.instanceId.slice(-6)} → ${joint.b.instanceId.slice(-6)} · axis ${axisLabel}`}
      inline={
        <>
          <CommitInput
            className="mechanisms-joint-input"
            value={String(currentValue)}
            label={`Joint value for ${joint.id} (${unit})`}
            onCommit={commitInput}
            testId={`joint-value-${joint.id}`}
            inputProps={{ type: 'number', title: `Current ${revolute ? 'angle' : 'displacement'} in ${unit}` }}
          />
          <span className="panel__row-meta">{unit}</span>
        </>
      }
      actions={
        <DeleteButton
          testId={`joint-delete-${joint.id}`}
          onDelete={() => dispatch('delete_joint', { id: joint.id })}
          title="Delete this joint"
          label={`Delete joint ${joint.id}`}
        />
      }
    />
  );
}

function DriveRelationRow({ relation }: { relation: DriveRelation }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const offsetLabel = relation.offset !== undefined && relation.offset !== 0 ? ` + ${relation.offset.toFixed(3)}` : '';

  return (
    <MechanismRow
      noun="drive"
      id={relation.id}
      info={
        <>
          <strong>{relation.driver.slice(-6)}</strong>
          {' → '}
          <strong>{relation.driven.slice(-6)}</strong>
          {' · ratio '}
          <span className="mechanisms-ratio">{relation.ratio.toFixed(4)}</span>
          {offsetLabel}
        </>
      }
      actions={
        <DeleteButton
          testId={`drive-delete-${relation.id}`}
          onDelete={() => dispatch('delete_drive_relation', { id: relation.id })}
          title="Delete this drive relation"
          label={`Delete drive relation ${relation.id}`}
        />
      }
    />
  );
}

interface MechanismSectionProps {
  /** Plural section title; lower-cased it names the count and the empty state. */
  title: string;
  testId: string;
  listLabel: string;
  rows: ReadonlyArray<React.ReactElement>;
  /** Start collapsed while empty (a physics model has no kinematic constraints to show). */
  collapseEmpty: boolean;
}

function MechanismSection({ title, testId, listLabel, rows, collapseEmpty }: MechanismSectionProps): React.ReactElement {
  const noun = title.toLowerCase();
  return (
    <PanelSection
      collapsible
      defaultOpen={!collapseEmpty || rows.length > 0}
      title={title}
      count={rows.length}
      countLabel={`${rows.length} ${noun}`}
      testId={testId}
    >
      {rows.length === 0 ? (
        <PanelEmpty compact icon="mechanism" message={`No ${noun} defined.`} />
      ) : (
        <ul className="panel__list" aria-label={listLabel}>
          {rows}
        </ul>
      )}
    </PanelSection>
  );
}

export function MechanismsPanel({ className }: { className?: string }): React.ReactElement {
  const constraints = useStore((s) => s.document.constraints);
  const constraintOrder = useStore((s) => s.document.constraintOrder);
  const joints = useStore((s) => s.document.joints);
  const jointOrder = useStore((s) => s.document.jointOrder);
  const driveRelations = useStore((s) => s.document.driveRelations);
  const driveRelationOrder = useStore((s) => s.document.driveRelationOrder);

  const hasBodies = useStore((s) => Object.keys(s.document.dynamics?.bodies ?? {}).length > 0);
  const mechanismSelection = useViewportStore((s) => s.mechanismSelection);
  const setMechanismSelection = useViewportStore((s) => s.setMechanismSelection);

  const isHighlighted = (kind: 'constraint' | 'joint', id: string): boolean =>
    mechanismSelection?.kind === kind && mechanismSelection.id === id;
  const highlight =
    (kind: 'constraint' | 'joint') =>
    (id: string): void =>
      setMechanismSelection(isHighlighted(kind, id) ? null : { kind, id });

  const nothingDefined = !hasBodies && constraintOrder.length === 0 && jointOrder.length === 0 && driveRelationOrder.length === 0;
  if (nothingDefined) {
    return (
      <aside className={classNames('panel mechanisms-panel', className)} aria-label="Mechanisms">
        <PanelHeader title="Mechanisms" />
        <PanelEmpty
          icon="mechanism"
          message="No mechanisms yet."
          hint="Constrain parts, link them with joints, or make them physical."
          actions={MECHANISM_ACTIONS}
        />
      </aside>
    );
  }

  return (
    <aside className={classNames('panel mechanisms-panel', className)} aria-label="Mechanisms">
      <PanelHeader title="Mechanisms" />
      {hasBodies && <PhysicsLoadsSection />}
      {hasBodies && <PhysicsSection />}
      <MechanismSection
        title="Constraints"
        testId="mechanisms-section-constraints"
        collapseEmpty={hasBodies}
        listLabel="Constraint list"
        rows={orderedValues(constraintOrder, constraints).map((constraint) => (
          <ConstraintRow
            key={constraint.id}
            constraint={constraint}
            highlighted={isHighlighted('constraint', constraint.id)}
            onHighlight={highlight('constraint')}
          />
        ))}
      />
      <MechanismSection
        title="Joints"
        testId="mechanisms-section-joints"
        collapseEmpty={hasBodies}
        listLabel="Joint list"
        rows={orderedValues(jointOrder, joints).map((joint) => (
          <JointRow key={joint.id} joint={joint} highlighted={isHighlighted('joint', joint.id)} onHighlight={highlight('joint')} />
        ))}
      />
      <MechanismSection
        title="Drive Relations"
        testId="mechanisms-section-drive relations"
        collapseEmpty={hasBodies}
        listLabel="Drive relation list"
        rows={orderedValues(driveRelationOrder, driveRelations).map((relation) => (
          <DriveRelationRow key={relation.id} relation={relation} />
        ))}
      />
      {!hasBodies && <PhysicsSection />}
    </aside>
  );
}
