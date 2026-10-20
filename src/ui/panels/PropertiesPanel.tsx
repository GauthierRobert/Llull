// Right-docked inspector: name, position and (3D only) rotation commit set_entity_name / move_entities / rotate_entity
// with the delta from the stored value.

import { toDegrees, toRadians } from '@lib/angle';
import React, { useMemo } from 'react';
import { classNames } from '@ui/classNames';
import { useStore, useViewportStore } from '@ui/store';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { deleteSelection, duplicateSelection } from '@ui/actions/selectionActions';
import { type Entity, is2D } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { type Kpi, KpiStrip, PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { entitiesFocus, sizeLabel } from '@ui/panels/entityFocus';
import { formatMass, totalMassG } from '@ui/panels/materials/materialUsage';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import { AxisFields, CommitInput, PropRow } from './propertyFields';
import { dimensionRows } from './entityDimensions';
import { ElementInspector } from './building/ElementInspector';
import { ExchangeProvenanceSection } from './exchange/ExchangeReport';
import { buildingElementOf } from '@aec/index';

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

/** Headline of the selected entity: overall size (click: highlight it on the model), material, mass. */
function EntityHeadline({ entity }: { entity: Entity }): React.ReactElement | null {
  const focusItem = useFocusItem();
  const units = useStore((s) => s.document.units);
  const materials = useStore((s) => s.document.materials);
  const items = useMemo((): Kpi[] => {
    const doc = useStore.getState().document;
    const size = sizeLabel(entityBoundsInDoc(doc, entity), units);
    const material = entity.materialId === undefined ? undefined : materials[entity.materialId];
    const massG = is2D(entity) ? null : totalMassG(doc, [entity.id]);
    const kpis: Kpi[] = [];
    if (size !== '') {
      kpis.push({
        key: 'overall',
        label: 'Overall',
        value: size,
        onClick: () =>
          focusItem(entitiesFocus(doc, { key: `properties:entity:${entity.id}`, label: entity.name ?? entity.id, ids: [entity.id] })),
      });
    }
    if (material !== undefined) kpis.push({ key: 'material', label: 'Material', value: material.name });
    if (massG !== null) kpis.push({ key: 'mass', label: 'Mass', value: formatMass(massG) });
    return kpis;
  }, [entity, units, materials, focusItem]);
  return <KpiStrip items={items} label="Selection headline" />;
}

function EntityDetail({ entity }: { entity: Entity }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const provenance = useStore((s) => s.document.exchange?.provenance[entity.id]);
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

      <EntityHeadline entity={entity} />

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
              dispatch('move_entities', { ids: [entity.id], delta: axisDelta(entity.position, axisIndex, value) })
            }
          />
        </PropRow>
        {/* 2D shapes are drawn and picked unrotated: rotation is 3D-only. */}
        {!is2D(entity) && (
          <PropRow label="Rotation°">
            <AxisFields
              values={entity.rotation.map((r) => toDegrees(r))}
              label="Rotation"
              onAxisCommit={(axisIndex, degrees) =>
                dispatch('rotate_entity', { id: entity.id, delta: axisDelta(entity.rotation, axisIndex, toRadians(degrees)) })
              }
            />
          </PropRow>
        )}
      </PanelSection>

      {geometryRows !== null && <PanelSection title="Geometry">{geometryRows}</PanelSection>}

      <PanelSection title="Appearance">
        <PropRow label="Color">
          <span className="props-color">
            <span role="img" className="props-color-swatch" style={{ background: entity.color }} aria-label={entity.color} />
            <span className="props-number">{entity.color}</span>
          </span>
        </PropRow>
      </PanelSection>

      {provenance !== undefined && (
        <PanelSection title="Exchange">
          <ExchangeProvenanceSection provenance={provenance} />
        </PanelSection>
      )}

      <SelectionActions />
    </section>
  );
}

function PropertiesBody(): React.ReactElement {
  // Narrow slices: camera / orbit changes must not re-render the inspector.
  const selection = useStore((s) => s.document.selection);
  const entities = useStore((s) => s.document.entities);
  const building = useStore((s) => s.document.building);
  const document = building === undefined ? { entities } : { entities, building };
  const entity = useSoleSelectedEntity();
  const elementIds = new Set<string>();
  for (const id of selection) {
    const elementId = buildingElementOf(document, id);
    if (elementId !== null) elementIds.add(elementId);
  }
  const [soleElementId] = elementIds;
  const everyEntityBelongs = selection.every((id) => buildingElementOf(document, id) !== null);

  if (selection.length === 0) {
    return (
      <PanelEmpty
        icon="cursor"
        message="No entity selected"
        hint="Click an object in the viewport to edit its name, position and rotation."
      />
    );
  }
  if (elementIds.size === 1 && everyEntityBelongs && soleElementId !== undefined) return <ElementInspector elementId={soleElementId} />;
  if (selection.length > 1) {
    return (
      <>
        <PanelEmpty
          icon="layers"
          message={
            elementIds.size > 0
              ? `${selection.length} entities (${elementIds.size} building elements) selected`
              : `${selection.length} entities selected`
          }
          hint="Select a single entity to see its properties."
        />
        <SelectionActions />
      </>
    );
  }
  return entity === undefined ? <PanelEmpty icon="info" message="Entity not found." /> : <EntityDetail entity={entity} />;
}

export function PropertiesPanel({ className }: { className?: string }): React.ReactElement {
  return (
    <aside className={classNames('panel properties-panel', className)} aria-label="Properties">
      <PanelHeader title="Properties" />
      <PropertiesBody />
    </aside>
  );
}
