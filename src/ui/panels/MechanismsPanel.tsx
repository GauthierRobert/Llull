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

import React, { useCallback, useState } from 'react';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import type { Constraint, Joint, DriveRelation } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Chip label colors keyed by constraint kind. */
const CONSTRAINT_CHIP_COLOR: Record<string, string> = {
  coincident: '#5b8dee',
  parallel: '#52c05a',
  perpendicular: '#e0a852',
  tangent: '#c05298',
  distance: '#e05252',
  angle: '#52a0c0',
};

/** Chip label colors keyed by joint kind. */
const JOINT_CHIP_COLOR: Record<string, string> = {
  revolute: '#00e5ff',
  prismatic: '#e040fb',
};

function kindChipStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    backgroundColor: `${color}22`,
    color,
    border: `1px solid ${color}66`,
    marginRight: 6,
    flexShrink: 0,
  };
}

/** Format an EntityRef for display: "entityId[:kind]". */
function fmtEntityRef(ref: Constraint['a'] | Constraint['b']): string {
  const shortId = ref.entityId.slice(-6);
  if ('kind' in ref && ref.kind) return `${shortId}:${ref.kind}`;
  return shortId;
}

// ---------------------------------------------------------------------------
// Section A — Constraints
// ---------------------------------------------------------------------------

interface ConstraintRowProps {
  constraint: Constraint;
  highlighted: boolean;
  onHighlight: (id: string) => void;
}

function ConstraintRow({ constraint, highlighted, onHighlight }: ConstraintRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatch('delete_constraint', { id: constraint.id });
    },
    [dispatch, constraint.id],
  );

  const handleSolve = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatch('solve_constraints', {});
    },
    [dispatch],
  );

  const handleClick = useCallback(() => {
    onHighlight(constraint.id);
  }, [onHighlight, constraint.id]);

  const chipColor = CONSTRAINT_CHIP_COLOR[constraint.kind] ?? '#888';
  const aRef = fmtEntityRef(constraint.a);
  const bRef = fmtEntityRef(constraint.b);

  const value =
    'value' in constraint && constraint.value !== undefined
      ? ` = ${typeof constraint.value === 'number' ? constraint.value.toFixed(3) : String(constraint.value)}`
      : '';

  return (
    <li
      className={`mechanisms-row${highlighted ? ' mechanisms-row--highlighted' : ''}`}
      data-testid={`constraint-row-${constraint.id}`}
      onClick={handleClick}
      aria-selected={highlighted}
      role="option"
      style={{ cursor: 'pointer' }}
    >
      <span style={kindChipStyle(chipColor)}>{constraint.kind}</span>
      <span className="mechanisms-row-info" style={{ flex: 1, fontSize: 12, color: 'var(--color-text-secondary, #9aa)' }}>
        {aRef} → {bRef}{value}
      </span>
      <button
        type="button"
        className="mechanisms-action-btn"
        data-testid={`constraint-solve-${constraint.id}`}
        onClick={handleSolve}
        title="Solve all constraints"
        aria-label="Solve constraints"
        style={{ marginRight: 4 }}
      >
        Solve
      </button>
      <button
        type="button"
        className="mechanisms-action-btn mechanisms-action-btn--danger"
        data-testid={`constraint-delete-${constraint.id}`}
        onClick={handleDelete}
        title="Delete this constraint"
        aria-label={`Delete constraint ${constraint.id}`}
      >
        Delete
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section B — Joints
// ---------------------------------------------------------------------------

interface JointRowProps {
  joint: Joint;
  highlighted: boolean;
  onHighlight: (id: string) => void;
}

function JointRow({ joint, highlighted, onHighlight }: JointRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const currentValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
  const [inputValue, setInputValue] = useState<string>(String(currentValue));

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleInputCommit = useCallback(() => {
    const parsed = parseFloat(inputValue);
    if (!isNaN(parsed)) {
      dispatch('set_joint_value', { id: joint.id, value: parsed });
    } else {
      // Revert to current value on invalid input.
      setInputValue(String(currentValue));
    }
  }, [dispatch, joint.id, inputValue, currentValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleInputCommit();
      else if (e.key === 'Escape') setInputValue(String(currentValue));
    },
    [handleInputCommit, currentValue],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatch('delete_joint', { id: joint.id });
    },
    [dispatch, joint.id],
  );

  const handleClick = useCallback(() => {
    onHighlight(joint.id);
  }, [onHighlight, joint.id]);

  const chipColor = JOINT_CHIP_COLOR[joint.kind] ?? '#888';
  const axisLabel = Array.isArray(joint.axis) ? `[${(joint.axis as number[]).join(',')}]` : joint.axis;
  const unit = joint.kind === 'revolute' ? 'rad' : 'mm';

  return (
    <li
      className={`mechanisms-row${highlighted ? ' mechanisms-row--highlighted' : ''}`}
      data-testid={`joint-row-${joint.id}`}
      onClick={handleClick}
      aria-selected={highlighted}
      role="option"
      style={{ cursor: 'pointer' }}
    >
      <span style={kindChipStyle(chipColor)}>{joint.kind}</span>
      <span className="mechanisms-row-info" style={{ flex: 1, fontSize: 12, color: 'var(--color-text-secondary, #9aa)' }}>
        {joint.a.instanceId.slice(-6)} → {joint.b.instanceId.slice(-6)} · axis {axisLabel}
      </span>
      <input
        type="number"
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleInputCommit}
        onKeyDown={handleKeyDown}
        aria-label={`Joint value for ${joint.id} (${unit})`}
        data-testid={`joint-value-${joint.id}`}
        title={`Current ${joint.kind === 'revolute' ? 'angle' : 'displacement'} in ${unit}`}
        style={{ width: 64, marginRight: 4, fontSize: 12 }}
        onClick={(e) => e.stopPropagation()}
      />
      <span style={{ fontSize: 10, marginRight: 6, color: 'var(--color-text-secondary, #9aa)' }}>{unit}</span>
      <button
        type="button"
        className="mechanisms-action-btn mechanisms-action-btn--danger"
        data-testid={`joint-delete-${joint.id}`}
        onClick={handleDelete}
        title="Delete this joint"
        aria-label={`Delete joint ${joint.id}`}
      >
        Delete
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section C — Drive Relations
// ---------------------------------------------------------------------------

interface DriveRelationRowProps {
  relation: DriveRelation;
}

function DriveRelationRow({ relation }: DriveRelationRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatch('delete_drive_relation', { id: relation.id });
    },
    [dispatch, relation.id],
  );

  const offsetLabel =
    relation.offset !== undefined && relation.offset !== 0
      ? ` + ${relation.offset.toFixed(3)}`
      : '';

  return (
    <li
      className="mechanisms-row"
      data-testid={`drive-row-${relation.id}`}
    >
      <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text-secondary, #9aa)' }}>
        <span style={{ fontWeight: 600 }}>{relation.driver.slice(-6)}</span>
        {' → '}
        <span style={{ fontWeight: 600 }}>{relation.driven.slice(-6)}</span>
        {' · ratio '}
        <span style={{ color: 'var(--color-text-primary, #ddd)' }}>{relation.ratio.toFixed(4)}</span>
        {offsetLabel}
      </span>
      <button
        type="button"
        className="mechanisms-action-btn mechanisms-action-btn--danger"
        data-testid={`drive-delete-${relation.id}`}
        onClick={handleDelete}
        title="Delete this drive relation"
        aria-label={`Delete drive relation ${relation.id}`}
      >
        Delete
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function Section({ title, count, children, defaultOpen = true }: SectionProps): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mechanisms-section" data-testid={`mechanisms-section-${title.toLowerCase()}`}>
      <button
        type="button"
        className="mechanisms-section-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '6px 8px',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 10, opacity: 0.6, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
          ▶
        </span>
        <span style={{ fontWeight: 600, fontSize: 12 }}>{title}</span>
        <span
          className="mechanisms-section-count"
          aria-label={`${count} ${title.toLowerCase()}`}
          style={{
            fontSize: 10,
            background: 'var(--color-bg-tertiary, #2a3040)',
            borderRadius: 10,
            padding: '0 5px',
            color: 'var(--color-text-secondary, #9aa)',
          }}
        >
          {count}
        </span>
      </button>
      {open && <div className="mechanisms-section-body" style={{ paddingBottom: 4 }}>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MechanismsPanel — exported component
// ---------------------------------------------------------------------------

export interface MechanismsPanelProps {
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

  const handleHighlightConstraint = useCallback(
    (id: string) => {
      const alreadySelected = mechanismSelection?.kind === 'constraint' && mechanismSelection.id === id;
      setMechanismSelection(alreadySelected ? null : { kind: 'constraint', id });
    },
    [mechanismSelection, setMechanismSelection],
  );

  const handleHighlightJoint = useCallback(
    (id: string) => {
      const alreadySelected = mechanismSelection?.kind === 'joint' && mechanismSelection.id === id;
      setMechanismSelection(alreadySelected ? null : { kind: 'joint', id });
    },
    [mechanismSelection, setMechanismSelection],
  );

  const constraintList = constraintOrder.map((id) => constraints[id]).filter((c): c is Constraint => c !== undefined);
  const jointList = jointOrder.map((id) => joints[id]).filter((j): j is Joint => j !== undefined);
  const driveList = driveRelationOrder.map((id) => driveRelations[id]).filter((d): d is DriveRelation => d !== undefined);

  return (
    <aside
      className={['mechanisms-panel', className].filter(Boolean).join(' ')}
      aria-label="Mechanisms"
    >
      {/* ---- Section A: Constraints ---- */}
      <Section title="Constraints" count={constraintList.length}>
        {constraintList.length === 0 ? (
          <p className="mechanisms-empty-hint" style={{ padding: '4px 12px', fontSize: 12, opacity: 0.6 }}>
            No constraints defined.
          </p>
        ) : (
          <ul
            className="mechanisms-list"
            aria-label="Constraint list"
            role="listbox"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {constraintList.map((c) => (
              <ConstraintRow
                key={c.id}
                constraint={c}
                highlighted={mechanismSelection?.kind === 'constraint' && mechanismSelection.id === c.id}
                onHighlight={handleHighlightConstraint}
              />
            ))}
          </ul>
        )}
      </Section>

      {/* ---- Section B: Joints ---- */}
      <Section title="Joints" count={jointList.length}>
        {jointList.length === 0 ? (
          <p className="mechanisms-empty-hint" style={{ padding: '4px 12px', fontSize: 12, opacity: 0.6 }}>
            No joints defined.
          </p>
        ) : (
          <ul
            className="mechanisms-list"
            aria-label="Joint list"
            role="listbox"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {jointList.map((j) => (
              <JointRow
                key={j.id}
                joint={j}
                highlighted={mechanismSelection?.kind === 'joint' && mechanismSelection.id === j.id}
                onHighlight={handleHighlightJoint}
              />
            ))}
          </ul>
        )}
      </Section>

      {/* ---- Section C: Drive Relations ---- */}
      <Section title="Drive Relations" count={driveList.length}>
        {driveList.length === 0 ? (
          <p className="mechanisms-empty-hint" style={{ padding: '4px 12px', fontSize: 12, opacity: 0.6 }}>
            No drive relations defined.
          </p>
        ) : (
          <ul
            className="mechanisms-list"
            aria-label="Drive relation list"
            role="list"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {driveList.map((d) => (
              <DriveRelationRow key={d.id} relation={d} />
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}
