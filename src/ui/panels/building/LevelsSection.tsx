/**
 * @layer ui/panels/building
 *
 * LevelsSection — storey list (activate / delete) + add-level form.
 * Dispatches: add_level, set_active_level, delete_level, update_level, copy_level_elements.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel } from '@core/model/building';
import { PanelSection, IconButton } from '@ui/panels/PanelParts';
import { orderedValues } from '@ui/panels/orderedValues';
import { CopyLevelForm, LevelEditForm } from './LevelEditors';

const EMPTY_LEVELS: ReadonlyArray<BuildingLevel> = [];

interface LevelRowProps {
  level: BuildingLevel;
  active: boolean;
  units: string;
  levels: ReadonlyArray<BuildingLevel>;
}

type RowMode = 'edit' | 'copy' | null;

function LevelRow({ level, active, units, levels }: LevelRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [mode, setMode] = useState<RowMode>(null);
  const toggle = (next: Exclude<RowMode, null>): void => setMode(mode === next ? null : next);
  return (
    <>
      <li
        className={`panel__row${active ? ' panel__row--selected' : ''}`}
        data-testid={`level-row-${level.id}`}
        aria-current={active ? 'true' : undefined}
      >
        <button
          type="button"
          className="building-row-btn"
          onClick={() => dispatch('set_active_level', { levelId: level.id })}
        >
          {/* The accessible name is the visible text plus this prefix (WCAG label-in-name). */}
          <span className="visually-hidden">Activate level </span>
          <span className="panel__row-main">{level.name}</span>{' '}
          <span className="panel__row-meta">
            +{level.elevation} {units} · h {level.height}
          </span>
        </button>
        <span className="panel__row-actions">
          <IconButton
            icon="parameters"
            size={12}
            label={`Edit level ${level.name}`}
            title="Edit name, elevation, height"
            pressed={mode === 'edit'}
            onClick={() => toggle('edit')}
          />
          <IconButton
            icon="copy"
            size={12}
            label={`Copy level ${level.name} to levels`}
            title="Copy this level's elements to other levels"
            pressed={mode === 'copy'}
            onClick={() => toggle('copy')}
          />
          <IconButton
            icon="close"
            danger
            size={12}
            label={`Delete level ${level.name}`}
            title="Delete level (and its elements)"
            onClick={() => dispatch('delete_level', { levelId: level.id, deleteElements: true })}
          />
        </span>
      </li>
      {mode === 'edit' && (
        <li>
          <LevelEditForm level={level} units={units} onDone={() => setMode(null)} />
        </li>
      )}
      {mode === 'copy' && (
        <li>
          <CopyLevelForm
            source={level}
            targets={levels.filter((candidate) => candidate.id !== level.id)}
            onDone={() => setMode(null)}
          />
        </li>
      )}
    </>
  );
}

function AddLevelForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [name, setName] = useState('');
  const [height, setHeight] = useState('');

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const heightValue = Number(height);
    dispatch('add_level', {
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
      ...(height.trim() !== '' && Number.isFinite(heightValue) ? { height: heightValue } : {}),
    });
    setName('');
  };

  return (
    <form className="building-inline-form" onSubmit={handleSubmit} aria-label="Add level">
      <input
        type="text"
        placeholder="New level name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="New level name"
      />
      <input
        type="number"
        placeholder="Height"
        value={height}
        onChange={(event) => setHeight(event.target.value)}
        aria-label="New level height"
      />
      <button type="submit" className="btn btn--ghost btn--sm">
        Add level
      </button>
    </form>
  );
}

export function LevelsSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const levels = building ? orderedValues(building.levelOrder, building.levels) : EMPTY_LEVELS;
  return (
    <PanelSection
      title="Levels"
      count={levels.length}
      countLabel={`${levels.length} levels`}
      testId="building-levels"
    >
      <ul className="panel__list" aria-label="Building levels">
        {[...levels].reverse().map((level) => (
          <LevelRow
            key={level.id}
            level={level}
            active={level.id === building?.activeLevelId}
            units={units}
            levels={levels}
          />
        ))}
      </ul>
      <AddLevelForm />
    </PanelSection>
  );
}
