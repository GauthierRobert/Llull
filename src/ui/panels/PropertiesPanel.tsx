/**
 * @layer ui/panels
 * Right-docked entity inspector. Name, position and (3D only) rotation are editable; each
 * committed field dispatches set_entity_name / move_entity / rotate_entity with the delta from
 * the stored value.
 */

import React from 'react';
import { useStore, useViewportStore } from '@ui/store';
import { deleteSelection, duplicateSelection } from '@ui/actions/selectionActions';
import { is2D } from '@core/model/types';
import type { Entity } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { AxisFields, CommitInput, PropRow } from './propertyFields';
import { dimensionRows } from './entityDimensions';

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** Delta vector that changes component `axisIndex` of `current` to `target`. */
function axisDelta(current: readonly number[], axisIndex: number, target: number): number[] {
  return [0, 1, 2].map((i) => (i === axisIndex ? target - (current[i] ?? 0) : 0));
}

function EntityVisibilityToggle({ entityId }: { entityId: string }): React.ReactElement {
  const isHidden = useViewportStore((s) => s.hiddenEntityIds.has(entityId));
  const toggleVisibility = useViewportStore((s) => s.toggleEntityVisibility);
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

function EntityDetail({ entity }: { entity: Entity }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const geometryRows = dimensionRows(entity);
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
          <AxisFields
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
            <AxisFields
              values={entity.rotation.map((r) => r * DEGREES_PER_RADIAN)}
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

      {geometryRows !== null && <PanelSection title="Geometry">{geometryRows}</PanelSection>}

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

function PropertiesBody(): React.ReactElement {
  const selection = useStore((s) => s.document.selection);
  const entities = useStore((s) => s.document.entities);
  const [selectedId] = selection;
  const entity =
    selection.length === 1 && selectedId !== undefined ? entities[selectedId] : undefined;

  if (selection.length === 0) {
    return (
      <PanelEmpty
        icon="cursor"
        message="No entity selected"
        hint="Click an object in the viewport to edit its name, position and rotation."
      />
    );
  }
  if (selection.length > 1) {
    return (
      <>
        <PanelEmpty
          icon="layers"
          message={`${selection.length} entities selected`}
          hint="Select a single entity to see its properties."
        />
        <SelectionActions />
      </>
    );
  }
  return entity === undefined ? (
    <PanelEmpty icon="info" message="Entity not found." />
  ) : (
    <EntityDetail entity={entity} />
  );
}

export function PropertiesPanel({ className }: { className?: string }): React.ReactElement {
  return (
    <aside
      className={['panel properties-panel', className].filter(Boolean).join(' ')}
      aria-label="Properties"
    >
      <PanelHeader title="Properties" />
      <PropertiesBody />
    </aside>
  );
}
