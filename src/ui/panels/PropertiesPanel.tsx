/**
 * @layer ui/panels
 *
 * PropertiesPanel — the right-docked entity inspector.
 *
 * Shows the properties of the currently selected entity (kind, id, position,
 * color, and kind-specific dimensions). Name, position and (3D only) rotation are editable:
 * a committed field (Enter or blur) dispatches set_entity_name / move_entity /
 * rotate_entity with the delta from the stored value. Duplicate and Delete act on
 * the selection. For 0 or multiple selections, shows a summary count.
 *
 * PRIME DIRECTIVE: this panel NEVER builds an Entity or mutates the document —
 * every edit is a dispatch (architecture L1, react R1).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { deleteSelection, duplicateSelection } from '@ui/actions/selectionActions';
import { useViewportStore } from '@ui/store';
import { is2D } from '@core/model/types';
import type { Entity } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';

const AXES = ['x', 'y', 'z'] as const;

function formatNumber(n: number): string {
  return n.toFixed(3);
}

/** Shortest text for an editable field: 3 decimals at most, no trailing zeros, no "-0". */
function formatEditableNumber(n: number): string {
  const rounded = Number(n.toFixed(3));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function PropRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="props-row">
      <span className="props-key">{label}</span>
      <div className="props-value">{children}</div>
    </div>
  );
}

function AxisFields({ values }: { values: readonly number[] }): React.ReactElement {
  return (
    <div className="axis-fields">
      {values.slice(0, 3).map((n, i) => {
        const axis = AXES[i] ?? 'z';
        return (
          <span key={axis} className="axis-field">
            <span className={`axis-field__letter axis-field__letter--${axis}`} aria-hidden="true">
              {axis.toUpperCase()}
            </span>
            <span className="axis-field__value">{formatNumber(n)}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Text input that reports its value on Enter or blur; Esc reverts. */
function CommitInput({
  value,
  label,
  className,
  placeholder,
  inputMode,
  onCommit,
}: {
  value: string;
  label: string;
  className: string;
  placeholder?: string;
  inputMode?: 'decimal';
  onCommit: (text: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      className={className}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      inputMode={inputMode}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * Editable X/Y/Z triple. Each field is keyed by its stored value so it resets whenever the
 * document changes; `onAxisCommit` receives the parsed finite value only.
 */
function EditableAxisFields({
  values,
  label,
  onAxisCommit,
}: {
  values: readonly number[];
  label: string;
  onAxisCommit: (axisIndex: number, value: number) => void;
}): React.ReactElement {
  return (
    <div className="axis-fields">
      {values.slice(0, 3).map((n, i) => {
        const axis = AXES[i] ?? 'z';
        const text = formatEditableNumber(n);
        return (
          <label key={`${axis}:${text}`} className="axis-field axis-field--editable">
            <span className={`axis-field__letter axis-field__letter--${axis}`} aria-hidden="true">
              {axis.toUpperCase()}
            </span>
            <CommitInput
              className="axis-field__input"
              label={`${label} ${axis.toUpperCase()}`}
              value={text}
              inputMode="decimal"
              onCommit={(raw) => {
                const parsed = Number.parseFloat(raw);
                if (Number.isFinite(parsed)) onAxisCommit(i, parsed);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** Delta vector that changes component `axisIndex` of `current` to `target`. */
function axisDelta(current: readonly number[], axisIndex: number, target: number): number[] {
  return [0, 1, 2].map((i) => (i === axisIndex ? target - (current[i] ?? 0) : 0));
}

function ScalarRow({
  label,
  value,
  unit,
}: {
  label: string;
  value: number;
  unit?: string;
}): React.ReactElement {
  return (
    <PropRow label={label}>
      <span className="props-number">
        {formatNumber(value)}
        {unit !== undefined && <span className="props-unit">{unit}</span>}
      </span>
    </PropRow>
  );
}

function EntityVisibilityToggle({ entityId }: { entityId: string }): React.ReactElement {
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const toggleVisibility = useViewportStore((s) => s.toggleEntityVisibility);
  const isHidden = hiddenEntityIds.has(entityId);
  const label = isHidden ? 'Show entity in viewport' : 'Hide entity in viewport';

  return (
    <button
      type="button"
      className={`icon-btn props-visibility-btn${isHidden ? ' props-visibility-btn--hidden' : ''}`}
      aria-label={label}
      title={label}
      onClick={() => toggleVisibility(entityId)}
    >
      <Icon name={isHidden ? 'eyeOff' : 'eye'} size={15} />
    </button>
  );
}

const DIMENSIONED_KINDS: ReadonlySet<Entity['kind']> = new Set<Entity['kind']>([
  'box',
  'cylinder',
  'sphere',
  'circle',
  'extrusion',
  'arc',
  'rectangle',
  'line',
  'polyline',
]);

/** Kept in sync with the cases EntityDimensions renders. */
function hasDimensions(entity: Entity): boolean {
  return DIMENSIONED_KINDS.has(entity.kind);
}

function EntityDimensions({ entity }: { entity: Entity }): React.ReactElement | null {
  switch (entity.kind) {
    case 'box':
      return (
        <PropRow label="Size">
          <AxisFields values={entity.size} />
        </PropRow>
      );
    case 'cylinder':
      return (
        <>
          <ScalarRow label="Radius" value={entity.radius} />
          <ScalarRow label="Height" value={entity.height} />
        </>
      );
    case 'sphere':
    case 'circle':
      return <ScalarRow label="Radius" value={entity.radius} />;
    case 'extrusion':
      return <ScalarRow label="Depth" value={entity.depth} />;
    case 'arc':
      return (
        <>
          <ScalarRow label="Radius" value={entity.radius} />
          <ScalarRow label="Start Angle" value={entity.startAngle} unit="rad" />
          <ScalarRow label="End Angle" value={entity.endAngle} unit="rad" />
        </>
      );
    case 'rectangle':
      return (
        <>
          <ScalarRow label="Width" value={entity.width} />
          <ScalarRow label="Height" value={entity.height} />
        </>
      );
    case 'line':
      return (
        <>
          <PropRow label="Start">
            <AxisFields values={entity.start} />
          </PropRow>
          <PropRow label="End">
            <AxisFields values={entity.end} />
          </PropRow>
        </>
      );
    case 'polyline':
      return (
        <PropRow label="Points">
          <span className="props-number">
            {entity.points.length}
            <span className="props-unit">pts</span>
          </span>
        </PropRow>
      );
    default:
      return null;
  }
}

function EntityDetail({ entity }: { entity: Entity }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const rotationDegrees = entity.rotation.map((r) => r * DEGREES_PER_RADIAN);
  return (
    <section className="props-detail" aria-label="Selection">
      <div className="props-summary">
        <span className="props-summary__icon" aria-hidden="true">
          <Icon name={is2D(entity) ? 'square' : 'cube'} size={18} />
        </span>
        <div className="props-summary__text">
          <span className="props-summary__name" title={entity.name ?? entity.id}>
            {entity.name ?? entity.id}
          </span>
          <div className="props-summary__meta">
            <span className="chip chip--accent">{entity.kind}</span>
            {entity.name !== undefined && <span className="props-id">{entity.id}</span>}
          </div>
        </div>
        <EntityVisibilityToggle entityId={entity.id} />
      </div>

      <PanelSection title="Transform">
        <PropRow label="Name">
          <CommitInput
            key={`${entity.id}:${entity.name ?? ''}`}
            className="props-text-input"
            label="Name"
            value={entity.name ?? ''}
            placeholder="Unnamed"
            onCommit={(name) => dispatch('set_entity_name', { id: entity.id, name: name.trim() })}
          />
        </PropRow>
        <PropRow label="Position">
          <EditableAxisFields
            values={entity.position}
            label="Position"
            onAxisCommit={(axisIndex, value) =>
              dispatch('move_entity', {
                id: entity.id,
                delta: axisDelta(entity.position, axisIndex, value),
              })
            }
          />
        </PropRow>
        {/* 2D shapes are drawn and picked unrotated, so rotation is a 3D-only edit. */}
        {!is2D(entity) && (
          <PropRow label="Rotation°">
            <EditableAxisFields
              values={rotationDegrees}
              label="Rotation"
              onAxisCommit={(axisIndex, degrees) =>
                dispatch('rotate_entity', {
                  id: entity.id,
                  delta: axisDelta(entity.rotation, axisIndex, degrees / DEGREES_PER_RADIAN),
                })
              }
            />
          </PropRow>
        )}
      </PanelSection>

      {hasDimensions(entity) && (
        <PanelSection title="Geometry">
          <EntityDimensions entity={entity} />
        </PanelSection>
      )}

      <PanelSection title="Appearance">
        <PropRow label="Color">
          <span className="props-color">
            <span
              className="props-color-swatch"
              style={{ background: entity.color }}
              aria-label={entity.color}
            />
            <span className="props-number">{entity.color}</span>
          </span>
        </PropRow>
      </PanelSection>

      <SelectionActions />
    </section>
  );
}

function SelectionActions(): React.ReactElement {
  return (
    <div className="props-actions">
      <button type="button" className="props-action" onClick={duplicateSelection}>
        <Icon name="copy" size={14} />
        Duplicate
      </button>
      <button type="button" className="props-action props-action--danger" onClick={deleteSelection}>
        <Icon name="trash" size={14} />
        Delete
      </button>
    </div>
  );
}

interface PropertiesPanelProps {
  className?: string;
}

export function PropertiesPanel({ className }: PropertiesPanelProps): React.ReactElement {
  const selection = useStore((s) => s.document.selection);
  const entities = useStore((s) => s.document.entities);

  const [selectedId] = selection;
  const entity =
    selection.length === 1 && selectedId !== undefined ? entities[selectedId] : undefined;

  let body: React.ReactElement;
  if (selection.length === 0) {
    body = (
      <PanelEmpty
        icon="cursor"
        message="No entity selected"
        hint="Click an object in the viewport to edit its name, position and rotation."
      />
    );
  } else if (selection.length > 1) {
    body = (
      <>
        <PanelEmpty
          icon="layers"
          message={`${selection.length} entities selected`}
          hint="Select a single entity to see its properties."
        />
        <SelectionActions />
      </>
    );
  } else if (entity === undefined) {
    body = <PanelEmpty icon="info" message="Entity not found." />;
  } else {
    body = <EntityDetail entity={entity} />;
  }

  return (
    <aside
      className={['panel properties-panel', className].filter(Boolean).join(' ')}
      aria-label="Properties"
    >
      <PanelHeader title="Properties" />
      {body}
    </aside>
  );
}
