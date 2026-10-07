/**
 * @layer ui/panels
 *
 * MechanismsPanel — collapsible sections for constraints (solve_constraints, delete_constraint),
 * joints (set_joint_value, delete_joint) and drive relations (delete_drive_relation).
 * Selecting a constraint / joint row highlights it in `mechanismSelection` so `MechanismOverlay`
 * can draw a cue in the 3D viewport.
 */

import React, { useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore, useViewportStore } from '@ui/store';
import type { Constraint, Joint, DriveRelation } from '@core/model/types';
import { PanelEmpty, PanelHeader, PanelSection, IconButton } from '@ui/panels/PanelParts';
import { orderedValues } from '@ui/panels/orderedValues';

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

const mechanismRowClass = (highlighted: boolean): string =>
  classNames(
    'panel__row panel__row--overlay-actions mechanisms-row',
    highlighted && 'panel__row--selected mechanisms-row--highlighted',
  );

/** Format an EntityRef for display: "entityId[:kind]". */
function fmtEntityRef(ref: Constraint['a'] | Constraint['b']): string {
  const shortId = ref.entityId.slice(-6);
  if ('kind' in ref && ref.kind) return `${shortId}:${ref.kind}`;
  return shortId;
}

interface MechanismRowProps {
  noun: 'constraint' | 'joint';
  id: string;
  kind: string;
  tone: ChipTone;
  highlighted: boolean;
  onHighlight: (id: string) => void;
  info: React.ReactNode;
  /** Controls between the info text and the action buttons. */
  inline?: React.ReactNode;
  /** Buttons after the highlight toggle. */
  actions: React.ReactNode;
}

function MechanismRow({
  noun,
  id,
  kind,
  tone,
  highlighted,
  onHighlight,
  info,
  inline,
  actions,
}: MechanismRowProps): React.ReactElement {
  return (
    <li className={mechanismRowClass(highlighted)} data-testid={`${noun}-row-${id}`}>
      <span className={`chip chip--${tone}`}>{kind}</span>
      <span className="panel__row-main mechanisms-row-info">{info}</span>
      {inline}
      <div className="panel__row-actions">
        <IconButton
          icon="eye"
          testId={`${noun}-highlight-${id}`}
          pressed={highlighted}
          onClick={() => onHighlight(id)}
          title="Highlight in the viewport"
          label={`Highlight ${noun} ${id}`}
        />
        {actions}
      </div>
    </li>
  );
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
        </>
      }
    />
  );
}

interface JointRowProps {
  joint: Joint;
  highlighted: boolean;
  onHighlight: (id: string) => void;
}

/** Remounted (see `key`) whenever the document value changes, so the draft never goes stale. */
function JointRow({ joint, highlighted, onHighlight }: JointRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const currentValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
  const [inputValue, setInputValue] = useState<string>(String(currentValue));

  const commitInput = (): void => {
    const parsed = parseFloat(inputValue);
    if (isNaN(parsed)) setInputValue(String(currentValue));
    else if (parsed !== currentValue) dispatch('set_joint_value', { id: joint.id, value: parsed });
  };

  const chipTone = JOINT_CHIP_TONE[joint.kind] ?? 'accent';
  const axisLabel = Array.isArray(joint.axis) ? `[${joint.axis.join(',')}]` : joint.axis;
  const unit = joint.kind === 'revolute' ? 'rad' : 'mm';

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
          />
          <span className="panel__row-meta">{unit}</span>
        </>
      }
      actions={
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
      }
    />
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
    <li
      className="panel__row panel__row--overlay-actions mechanisms-row"
      data-testid={`drive-row-${relation.id}`}
    >
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

interface MechanismSectionProps {
  /** Plural section title; lower-cased it names the count and the empty state. */
  title: string;
  testId: string;
  listLabel: string;
  rows: ReadonlyArray<React.ReactElement>;
}

function MechanismSection({
  title,
  testId,
  listLabel,
  rows,
}: MechanismSectionProps): React.ReactElement {
  const noun = title.toLowerCase();
  return (
    <PanelSection
      collapsible
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

  return (
    <aside className={classNames('panel mechanisms-panel', className)} aria-label="Mechanisms">
      <PanelHeader title="Mechanisms" />
      <MechanismSection
        title="Constraints"
        testId="mechanisms-section-constraints"
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
        listLabel="Joint list"
        rows={orderedValues(jointOrder, joints).map((joint) => (
          <JointRow
            key={`${joint.id}:${joint.kind === 'revolute' ? joint.angle : joint.displacement}`}
            joint={joint}
            highlighted={isHighlighted('joint', joint.id)}
            onHighlight={highlight('joint')}
          />
        ))}
      />
      <MechanismSection
        title="Drive Relations"
        testId="mechanisms-section-drive relations"
        listLabel="Drive relation list"
        rows={orderedValues(driveRelationOrder, driveRelations).map((relation) => (
          <DriveRelationRow key={relation.id} relation={relation} />
        ))}
      />
    </aside>
  );
}
