/**
 * @layer ui/panels/building
 *
 * Inline level editors: LevelEditForm → update_level (changed fields only); CopyLevelForm →
 * copy_level_elements (source level's elements to chosen upper levels, optional categories).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel } from '@core/model/building';

/** Mirrors the copyable categories of copy_level_elements. */
export const COPYABLE_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ['wall', 'Walls'],
  ['curvedWall', 'Curved walls'],
  ['slab', 'Slabs'],
  ['column', 'Columns'],
  ['beam', 'Beams'],
  ['stair', 'Stairs'],
  ['room', 'Rooms'],
  ['member', 'Steel members'],
  ['footing', 'Footings'],
  ['panel', 'Panels'],
  ['equipment', 'Equipment'],
  ['pipe', 'Pipes'],
  ['tray', 'Cable trays'],
];

interface LevelEditFormProps {
  level: BuildingLevel;
  units: string;
  onDone: () => void;
}

export function LevelEditForm({ level, units, onDone }: LevelEditFormProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [name, setName] = useState(level.name);
  const [elevation, setElevation] = useState(String(level.elevation));
  const [height, setHeight] = useState(String(level.height));

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const changes: Record<string, unknown> = {};
    if (name.trim() !== '' && name.trim() !== level.name) changes['name'] = name.trim();
    if (elevation !== String(level.elevation) && Number.isFinite(Number(elevation))) {
      changes['elevation'] = Number(elevation);
    }
    if (height !== String(level.height) && Number.isFinite(Number(height))) {
      changes['height'] = Number(height);
    }
    if (Object.keys(changes).length > 0)
      dispatch('update_level', { levelId: level.id, ...changes });
    onDone();
  };

  return (
    <form
      className="panel__form building-form"
      onSubmit={handleSubmit}
      aria-label={`Edit level ${level.name}`}
    >
      <label className="field">
        <span className="field__label">Level name</span>
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Elevation ({units})</span>
        <input
          type="number"
          value={elevation}
          onChange={(event) => setElevation(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">Floor-to-floor height ({units})</span>
        <input type="number" value={height} onChange={(event) => setHeight(event.target.value)} />
      </label>
      <button type="submit" className="btn btn--primary btn--sm">
        Save level
      </button>
    </form>
  );
}

interface CopyLevelFormProps {
  source: BuildingLevel;
  targets: ReadonlyArray<BuildingLevel>;
  onDone: () => void;
}

function toggled(list: ReadonlyArray<string>, value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function CopyLevelForm({ source, targets, onDone }: CopyLevelFormProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (targetIds.length === 0) return;
    dispatch('copy_level_elements', {
      sourceLevelId: source.id,
      targetLevelIds: targetIds,
      ...(categories.length > 0 ? { categories } : {}),
    });
    onDone();
  };

  return (
    <form
      className="panel__form building-form"
      onSubmit={handleSubmit}
      aria-label={`Copy level ${source.name}`}
    >
      <fieldset className="field">
        <legend className="field__label">Copy to levels</legend>
        {targets.map((level) => (
          <label key={level.id} className="field">
            <input
              type="checkbox"
              checked={targetIds.includes(level.id)}
              onChange={() => setTargetIds((previous) => toggled(previous, level.id))}
            />
            <span>{level.name}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="field">
        <legend className="field__label">Categories (none ticked = all)</legend>
        {COPYABLE_CATEGORIES.map(([category, label]) => (
          <label key={category} className="field">
            <input
              type="checkbox"
              checked={categories.includes(category)}
              onChange={() => setCategories((previous) => toggled(previous, category))}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <button type="submit" className="btn btn--primary btn--sm" disabled={targetIds.length === 0}>
        Copy elements
      </button>
    </form>
  );
}
