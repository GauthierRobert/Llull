// `document.materials` (swatch, name, density): create_material, assign_material to the selection.

import React, { memo, useCallback, useMemo, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { useStableList } from '@ui/viewport/useStableByKey';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import { entitiesFocus } from '@ui/panels/entityFocus';
import { entityIdsByMaterial, formatMass, totalMassG } from '@ui/panels/materials/materialUsage';
import type { Material } from '@core/model/types';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { useDraftSubmit } from '@ui/hooks/useDraftSubmit';
import { materialDraftOf } from '@ui/panels/materialRules';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { parseNumber } from '@ui/numberText';
import { significantNumber } from '@lib/compactNumber';
import { MaterialLibrariesSection } from '@ui/panels/materials/MaterialLibrariesSection';
import { MaterialRecordInspector } from '@ui/panels/materials/MaterialRecordInspector';

/** 3 significant digits, no exponent for ordinary magnitudes (7850, not "7.85e+3"). */
function formatDensity(density: number): string {
  return significantNumber(density, 3);
}

const MaterialRow = memo(function MaterialRow({
  material,
  isSelected,
  onSelect,
  entityIds,
}: {
  material: Material;
  entityIds: readonly string[];
  isSelected: boolean;
  onSelect: (name: string) => void;
}): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  // A count, not the id array: rows do not re-render on every selection change.
  const selectedCount = useStore((s) => s.document.selection.length);
  const focusItem = useFocusItem();
  const focusKey = `materials:material:${material.name}`;
  const focused = useIsFocused(focusKey);
  const units = useStore((s) => s.document.units);
  const entities = useStore((s) => s.document.entities);
  // Only the mass of a material in use is measured, when one of ITS entities changes (per-entity cache in totalMassG).
  const used = useStableList(entityIds.map((id) => entities[id]));
  const massG = useMemo(
    () => (entityIds.length === 0 ? null : totalMassG(useStore.getState().document, entityIds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `used` (entity identities) is the staleness key of the document read above
    [used, material.density],
  );
  const usage = entityIds.length === 0 ? 'unused' : `${entityIds.length} ${entityIds.length === 1 ? 'object' : 'objects'}`;

  const handleSelect = (): void => {
    onSelect(material.name);
    focusItem(
      entitiesFocus(useStore.getState().document, {
        key: focusKey,
        label: `Material ${material.name} — ${usage}${massG === null ? '' : `, ${formatMass(massG)}`}`,
        color: material.color,
        ids: entityIds,
        ...(massG === null ? {} : { note: formatMass(massG) }),
      }),
    );
  };

  const handleAssign = (): void => {
    const entityIds = useStore.getState().document.selection;
    if (entityIds.length === 0) return;
    dispatch('assign_material', { materialName: material.name, entityIds });
  };

  return (
    <li
      className={`panel__row material-row${isSelected || focused ? ' panel__row--selected material-row--selected' : ''}`}
      data-testid={`material-row-${material.name}`}
      aria-label={`Material: ${material.name}`}
    >
      <button
        type="button"
        className="material-row-btn"
        aria-pressed={isSelected}
        onClick={handleSelect}
        aria-label={`Select material ${material.name}`}
        title={`${material.name} — click to highlight the ${usage === 'unused' ? 'objects (none yet)' : 'objects using it'}`}
      >
        <span className="material-swatch" style={{ background: material.color }} aria-hidden="true" title={material.color} />
        <span className="material-name" title={material.name}>
          {material.name}
          <span className="material-usage" data-testid={`material-usage-${material.name}`}>
            {usage}
            {massG !== null && ` · ${formatMass(massG)}`}
          </span>
        </span>
        <span className="material-density" title={`Density: ${material.density} g/${units}³`}>
          {formatDensity(material.density)}
          <span className="material-density-unit"> g/{units}³</span>
        </span>
      </button>

      <button
        type="button"
        className="material-assign-btn"
        onClick={handleAssign}
        disabled={selectedCount === 0}
        aria-label={`Assign material ${material.name} to selected entities`}
        title={
          selectedCount === 0 ? 'Select entities in the viewport first' : `Assign "${material.name}" to ${selectedCount} selected entity`
        }
      >
        Assign
      </button>
    </li>
  );
});

const NO_ENTITIES: readonly string[] = [];

const EMPTY_FORM = { name: '', density: '', color: '#b0b0b0', metalness: '0.08', roughness: '0.45' };

const SLIDERS = [
  { field: 'metalness', title: 'Metalness' },
  { field: 'roughness', title: 'Roughness' },
] as const;

function CreateMaterialForm(): React.ReactElement {
  const [form, setForm] = useState(EMPTY_FORM);
  const { name, density, color } = form;
  const setField =
    (field: keyof typeof EMPTY_FORM) =>
    (value: string): void =>
      setForm((previous) => ({ ...previous, [field]: value }));

  const draft = materialDraftOf(form);

  // A rejected create (e.g. duplicate name) keeps the typed values.
  const handleSubmit = useDraftSubmit('create_material', draft, () => setForm(EMPTY_FORM));

  return (
    <form
      className="panel__form material-create-form"
      onSubmit={handleSubmit}
      aria-label="Create new material"
      data-testid="material-create-form"
    >
      <span className="panel__form-title" aria-hidden="true">
        New material
      </span>
      <LabeledInput
        label="Name"
        type="text"
        value={name}
        onChange={setField('name')}
        placeholder="e.g. steel, pla"
        ariaLabel="New material name"
        inputProps={{ className: 'material-create-input', autoComplete: 'off' }}
      />
      <LabeledInput
        label="Density"
        type="number"
        value={density}
        onChange={setField('density')}
        placeholder="e.g. 0.00785"
        ariaLabel="Material density (g/mm³)"
        inputProps={{ step: 'any', min: '0', className: 'material-create-input', autoComplete: 'off' }}
      />
      <LabeledInput
        label="Color"
        type="color"
        value={color}
        onChange={setField('color')}
        ariaLabel="Material color"
        className="material-create-row--color"
        inputProps={{ className: 'material-create-color-picker' }}
      >
        <span className="material-create-color-hex" aria-hidden="true">
          {color}
        </span>
      </LabeledInput>
      {SLIDERS.map(({ field, title }) => (
        <LabeledInput
          key={field}
          label={title}
          type="range"
          value={form[field]}
          onChange={setField(field)}
          ariaLabel={`Material ${field} (0 to 1)`}
          inputProps={{ min: '0', max: '1', step: '0.01', className: 'material-create-range', 'aria-valuemin': 0, 'aria-valuemax': 1 }}
        >
          <span className="field__value">{(parseNumber(form[field]) ?? 0).toFixed(2)}</span>
        </LabeledInput>
      ))}

      <button
        type="submit"
        className="btn btn--primary btn--block"
        disabled={draft === null}
        aria-label="Create material"
        title="Create material"
      >
        Create
      </button>
    </form>
  );
}

export function MaterialsPanel({ className }: { className?: string }): React.ReactElement {
  const materials = useStore((s) => s.document.materials);
  const materialList = Object.values(materials);
  const documentOrder = useStore((s) => s.document.order);
  const documentEntities = useStore((s) => s.document.entities);
  const usageByMaterial = useMemo(
    () => entityIdsByMaterial({ order: documentOrder, entities: documentEntities }),
    [documentOrder, documentEntities],
  );

  const [activeMaterialName, setActiveMaterialName] = useState<string | null>(null);

  const handleMaterialSelect = useCallback((name: string): void => setActiveMaterialName((prev) => (prev === name ? null : name)), []);

  return (
    <aside className={classNames('panel materials-panel', className)} aria-label="Materials">
      <PanelHeader
        title="Materials"
        count={materialList.length}
        countLabel={`${materialList.length} material${materialList.length !== 1 ? 's' : ''}`}
      />

      {materialList.length === 0 ? (
        <PanelEmpty icon="materials" message="No materials defined." hint="Create one below, then assign it to the selection." />
      ) : (
        <ul className="panel__list" aria-label="Material list" role="list">
          {materialList.map((material) => (
            <MaterialRow
              key={material.name}
              material={material}
              isSelected={activeMaterialName === material.name}
              entityIds={usageByMaterial.get(material.name) ?? NO_ENTITIES}
              onSelect={handleMaterialSelect}
            />
          ))}
        </ul>
      )}

      <MaterialLibrariesSection onSelect={setActiveMaterialName} />
      {activeMaterialName !== null && <MaterialRecordInspector key={activeMaterialName} materialName={activeMaterialName} />}
      <CreateMaterialForm />
    </aside>
  );
}
