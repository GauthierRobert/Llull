/**
 * @layer ui/panels
 *
 * MaterialsPanel — lists `document.materials`, lets the user create new materials,
 * and assign the selected material to the currently selected entities.
 *
 * All mutations go through `dispatch`:
 *   - create_material  — define or replace a named material
 *   - assign_material  — assign a material name to selected entity ids
 *
 * Displays each material's color swatch, name, and density.
 * No business logic — the component only gathers input and dispatches.
 * (PRIME DIRECTIVE, architecture L1, react R1)
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { Material } from '@core/model/types';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { isHexColor } from '@lib/isHexColor';

interface MaterialRowProps {
  material: Material;
  selectedEntityIds: string[];
  isSelected: boolean;
  onSelect: (name: string) => void;
}

function MaterialRow({
  material,
  selectedEntityIds,
  isSelected,
  onSelect,
}: MaterialRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const handleAssign = (): void => {
    if (selectedEntityIds.length === 0) return;
    dispatch('assign_material', { materialName: material.name, entityIds: selectedEntityIds });
  };

  return (
    <li
      className={`panel__row material-row${isSelected ? ' panel__row--selected material-row--selected' : ''}`}
      data-testid={`material-row-${material.name}`}
      aria-label={`Material: ${material.name}`}
      aria-selected={isSelected}
    >
      <button
        type="button"
        className="material-row-btn"
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
          {material.density.toPrecision(3)}
        </span>
      </button>

      <button
        type="button"
        className="material-assign-btn"
        onClick={handleAssign}
        disabled={selectedEntityIds.length === 0}
        aria-label={`Assign material ${material.name} to selected entities`}
        title={
          selectedEntityIds.length === 0
            ? 'Select entities in the viewport first'
            : `Assign "${material.name}" to ${selectedEntityIds.length} selected entity`
        }
      >
        Assign
      </button>
    </li>
  );
}

const DEFAULT_COLOR = '#b0b0b0';

function CreateMaterialForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [name, setName] = useState('');
  const [density, setDensity] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [metalness, setMetalness] = useState('0.08');
  const [roughness, setRoughness] = useState('0.45');

  const densityNum = parseFloat(density);
  const metalnessNum = parseFloat(metalness);
  const roughnessNum = parseFloat(roughness);

  const isValid =
    name.trim() !== '' &&
    !isNaN(densityNum) &&
    densityNum > 0 &&
    isHexColor(color) &&
    !isNaN(metalnessNum) &&
    metalnessNum >= 0 &&
    metalnessNum <= 1 &&
    !isNaN(roughnessNum) &&
    roughnessNum >= 0 &&
    roughnessNum <= 1;

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!isValid) return;
    dispatch('create_material', {
      name: name.trim(),
      density: densityNum,
      color,
      metalness: metalnessNum,
      roughness: roughnessNum,
    });
    setName('');
    setDensity('');
    setColor(DEFAULT_COLOR);
    setMetalness('0.08');
    setRoughness('0.45');
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
          onChange={(e) => setName(e.target.value)}
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
          onChange={(e) => setDensity(e.target.value)}
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
          onChange={(e) => setColor(e.target.value)}
          aria-label="Material color"
        />
        <span className="material-create-color-hex" aria-hidden="true">
          {color}
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="material-create-metalness">
          Metalness
        </label>
        <input
          id="material-create-metalness"
          type="range"
          min="0"
          max="1"
          step="0.01"
          className="material-create-range"
          value={metalness}
          onChange={(e) => setMetalness(e.target.value)}
          aria-label="Material metalness (0 to 1)"
          aria-valuemin={0}
          aria-valuemax={1}
        />
        <span className="field__value">{parseFloat(metalness).toFixed(2)}</span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="material-create-roughness">
          Roughness
        </label>
        <input
          id="material-create-roughness"
          type="range"
          min="0"
          max="1"
          step="0.01"
          className="material-create-range"
          value={roughness}
          onChange={(e) => setRoughness(e.target.value)}
          aria-label="Material roughness (0 to 1)"
          aria-valuemin={0}
          aria-valuemax={1}
        />
        <span className="field__value">{parseFloat(roughness).toFixed(2)}</span>
      </div>

      <button
        type="submit"
        className="btn btn--primary btn--block"
        disabled={!isValid}
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
  const selection = useStore((s) => s.document.selection);
  const materialList = Object.values(materials).filter((m): m is Material => m != null);

  const [activeMaterialName, setActiveMaterialName] = useState<string | null>(null);

  const handleMaterialSelect = (name: string): void =>
    setActiveMaterialName((prev) => (prev === name ? null : name));

  return (
    <aside
      className={['panel materials-panel', className].filter(Boolean).join(' ')}
      aria-label="Materials"
    >
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
              selectedEntityIds={selection}
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
