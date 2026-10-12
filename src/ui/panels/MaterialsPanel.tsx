/**
 * @layer ui/panels
 *
 * MaterialsPanel — lists `document.materials` (swatch, name, density); creates
 * (create_material) and assigns them to the selection (assign_material).
 */

import React, { memo, useCallback, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import type { Material } from '@core/model/types';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { useIsMounted } from '@ui/hooks/useIsMounted';
import { materialDraftOf } from '@ui/panels/materialRules';
import { significantNumber } from '@lib/compactNumber';

/** 3 significant digits without exponent notation for ordinary magnitudes (7850, not "7.85e+3"). */
function formatDensity(density: number): string {
  return significantNumber(density, 3);
}

interface MaterialRowProps {
  material: Material;
  isSelected: boolean;
  onSelect: (name: string) => void;
}

const MaterialRow = memo(function MaterialRow({
  material,
  isSelected,
  onSelect,
}: MaterialRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  // A count (not the id array) keeps rows from re-rendering on every selection change.
  const selectedCount = useStore((s) => s.document.selection.length);

  const handleAssign = (): void => {
    const entityIds = useStore.getState().document.selection;
    if (entityIds.length === 0) return;
    dispatch('assign_material', { materialName: material.name, entityIds });
  };

  return (
    <li
      className={`panel__row material-row${isSelected ? ' panel__row--selected material-row--selected' : ''}`}
      data-testid={`material-row-${material.name}`}
      aria-label={`Material: ${material.name}`}
    >
      <button
        type="button"
        className="material-row-btn"
        aria-pressed={isSelected}
        onClick={() => onSelect(material.name)}
        aria-label={`Select material ${material.name}`}
        title={material.name}
      >
        <span
          className="material-swatch"
          style={{ background: material.color }}
          aria-hidden="true"
          title={material.color}
        />
        <span className="material-name" title={material.name}>
          {material.name}
        </span>
        <span className="material-density" title={`Density: ${material.density}`}>
          {formatDensity(material.density)}
        </span>
      </button>

      <button
        type="button"
        className="material-assign-btn"
        onClick={handleAssign}
        disabled={selectedCount === 0}
        aria-label={`Assign material ${material.name} to selected entities`}
        title={
          selectedCount === 0
            ? 'Select entities in the viewport first'
            : `Assign "${material.name}" to ${selectedCount} selected entity`
        }
      >
        Assign
      </button>
    </li>
  );
});

const EMPTY_FORM = {
  name: '',
  density: '',
  color: '#b0b0b0',
  metalness: '0.08',
  roughness: '0.45',
};

const SLIDERS = [
  { field: 'metalness', title: 'Metalness' },
  { field: 'roughness', title: 'Roughness' },
] as const;

function CreateMaterialForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [form, setForm] = useState(EMPTY_FORM);
  const { name, density, color } = form;
  const setField =
    (field: keyof typeof EMPTY_FORM) =>
    (e: React.ChangeEvent<HTMLInputElement>): void =>
      setForm((previous) => ({ ...previous, [field]: e.target.value }));

  const isMounted = useIsMounted();
  const draft = materialDraftOf(form);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (draft === null) return;
    dispatch('create_material', draft, {
      // A rejected create (e.g. duplicate name) keeps the typed values for correction.
      onResult: ({ changed }) => {
        if (changed && isMounted()) setForm(EMPTY_FORM);
      },
    });
  };

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
      <div className="field">
        <label className="field__label" htmlFor="material-create-name">
          Name
        </label>
        <input
          id="material-create-name"
          type="text"
          className="material-create-input"
          value={name}
          onChange={setField('name')}
          placeholder="e.g. steel, pla"
          aria-label="New material name"
          autoComplete="off"
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="material-create-density">
          Density
        </label>
        <input
          id="material-create-density"
          type="number"
          step="any"
          min="0"
          className="material-create-input"
          value={density}
          onChange={setField('density')}
          placeholder="e.g. 0.00785"
          aria-label="Material density (g/mm³)"
          autoComplete="off"
        />
      </div>

      <div className="field material-create-row--color">
        <label className="field__label" htmlFor="material-create-color">
          Color
        </label>
        <input
          id="material-create-color"
          type="color"
          className="material-create-color-picker"
          value={color}
          onChange={setField('color')}
          aria-label="Material color"
        />
        <span className="material-create-color-hex" aria-hidden="true">
          {color}
        </span>
      </div>

      {SLIDERS.map(({ field, title }) => (
        <div className="field" key={field}>
          <label className="field__label" htmlFor={`material-create-${field}`}>
            {title}
          </label>
          <input
            id={`material-create-${field}`}
            type="range"
            min="0"
            max="1"
            step="0.01"
            className="material-create-range"
            value={form[field]}
            onChange={setField(field)}
            aria-label={`Material ${field} (0 to 1)`}
            aria-valuemin={0}
            aria-valuemax={1}
          />
          <span className="field__value">{parseFloat(form[field]).toFixed(2)}</span>
        </div>
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

interface MaterialsPanelProps {
  className?: string;
}

export function MaterialsPanel({ className }: MaterialsPanelProps): React.ReactElement {
  const materials = useStore((s) => s.document.materials);
  const materialList = Object.values(materials);

  const [activeMaterialName, setActiveMaterialName] = useState<string | null>(null);

  const handleMaterialSelect = useCallback(
    (name: string): void => setActiveMaterialName((prev) => (prev === name ? null : name)),
    [],
  );

  return (
    <aside className={classNames('panel materials-panel', className)} aria-label="Materials">
      <PanelHeader
        title="Materials"
        count={materialList.length}
        countLabel={`${materialList.length} material${materialList.length !== 1 ? 's' : ''}`}
      />

      {materialList.length === 0 ? (
        <PanelEmpty
          icon="materials"
          message="No materials defined."
          hint="Create one below, then assign it to the selection."
        />
      ) : (
        <ul className="panel__list" aria-label="Material list" role="list">
          {materialList.map((material) => (
            <MaterialRow
              key={material.name}
              material={material}
              isSelected={activeMaterialName === material.name}
              onSelect={handleMaterialSelect}
            />
          ))}
        </ul>
      )}

      <CreateMaterialForm />
    </aside>
  );
}
