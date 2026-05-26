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

import React, { useState, useCallback } from 'react';
import { useStore } from '@ui/store';
import type { Material } from '@core/model/types';

// ---------------------------------------------------------------------------
// MaterialRow — one row per existing material
// ---------------------------------------------------------------------------

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

  const handleAssign = useCallback(() => {
    if (selectedEntityIds.length === 0) return;
    dispatch('assign_material', { materialName: material.name, entityIds: selectedEntityIds });
  }, [dispatch, material.name, selectedEntityIds]);

  const handleRowClick = useCallback(() => {
    onSelect(material.name);
  }, [onSelect, material.name]);

  return (
    <li
      className={`material-row${isSelected ? ' material-row--selected' : ''}`}
      data-testid={`material-row-${material.name}`}
      aria-label={`Material: ${material.name}`}
      aria-selected={isSelected}
    >
      <button
        type="button"
        className="material-row-btn"
        onClick={handleRowClick}
        aria-label={`Select material ${material.name}`}
        title={material.name}
      >
        {/* Color swatch — inline background is data, not theme (task constraint) */}
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

// ---------------------------------------------------------------------------
// CreateMaterialForm — inline form to create a new material
// ---------------------------------------------------------------------------

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
    !isNaN(densityNum) && densityNum > 0 &&
    /^#[0-9a-fA-F]{6}$/.test(color) &&
    !isNaN(metalnessNum) && metalnessNum >= 0 && metalnessNum <= 1 &&
    !isNaN(roughnessNum) && roughnessNum >= 0 && roughnessNum <= 1;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
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
    },
    [dispatch, isValid, name, densityNum, color, metalnessNum, roughnessNum],
  );

  return (
    <form
      className="material-create-form"
      onSubmit={handleSubmit}
      aria-label="Create new material"
      data-testid="material-create-form"
    >
      <div className="material-create-row">
        <label className="material-create-label" htmlFor="material-create-name">
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

      <div className="material-create-row">
        <label className="material-create-label" htmlFor="material-create-density">
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

      <div className="material-create-row material-create-row--color">
        <label className="material-create-label" htmlFor="material-create-color">
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

      <div className="material-create-row">
        <label className="material-create-label" htmlFor="material-create-metalness">
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
        <span className="material-create-range-value">{parseFloat(metalness).toFixed(2)}</span>
      </div>

      <div className="material-create-row">
        <label className="material-create-label" htmlFor="material-create-roughness">
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
        <span className="material-create-range-value">{parseFloat(roughness).toFixed(2)}</span>
      </div>

      <button
        type="submit"
        className="material-create-btn"
        disabled={!isValid}
        aria-label="Create material"
        title="Create material"
      >
        Create
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// MaterialsPanel
// ---------------------------------------------------------------------------

export interface MaterialsPanelProps {
  className?: string;
}

export function MaterialsPanel({ className }: MaterialsPanelProps): React.ReactElement {
  const materials = useStore((s) => s.document.materials);
  const selection = useStore((s) => s.document.selection);
  const materialList = Object.values(materials).filter((m): m is Material => m != null);

  // Local state: which material row is highlighted (for keyboard/mouse affordance).
  // This does NOT affect the document — it is purely a UI selection hint.
  const [activeMaterialName, setActiveMaterialName] = useState<string | null>(null);

  const handleMaterialSelect = useCallback((name: string) => {
    setActiveMaterialName((prev) => (prev === name ? null : name));
  }, []);

  return (
    <aside
      className={['materials-panel', className].filter(Boolean).join(' ')}
      aria-label="Materials"
    >
      <div className="materials-panel-header">
        <h2 className="materials-panel-title">Materials</h2>
        <span
          className="materials-panel-count"
          aria-label={`${materialList.length} material${materialList.length !== 1 ? 's' : ''}`}
        >
          {materialList.length}
        </span>
      </div>

      {materialList.length === 0 ? (
        <p className="materials-empty">No materials defined.</p>
      ) : (
        <ul className="material-list" aria-label="Material list" role="list">
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

      <div className="materials-panel-footer">
        <CreateMaterialForm />
      </div>
    </aside>
  );
}
