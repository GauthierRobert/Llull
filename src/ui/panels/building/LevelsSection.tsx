// Storeys (activate / delete) + add form: add_level, set_active_level, delete_level, update_level, copy_level_elements.

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel } from '@aec/building/types';
import { DeleteButton, IconButton, ListRow, PanelSection } from '@ui/panels/PanelParts';
import { optionalNumber, optionalText } from '@ui/numberText';
import { CopyLevelForm, LevelEditForm } from './LevelEditors';
import { useBuildingLevels } from './useBuildingLevels';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { entitiesFocus } from '@ui/panels/entityFocus';

const LEVEL_COLOR = '#7c4dff';

interface LevelRowProps {
  level: BuildingLevel;
  active: boolean;
  units: string;
  levels: ReadonlyArray<BuildingLevel>;
}

type RowMode = 'edit' | 'copy' | null;

function LevelRow({ level, active, units, levels }: LevelRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const focusItem = useFocusItem();
  const [mode, setMode] = useState<RowMode>(null);
  // Activating a level also shows what is on it: its elements highlighted on the model.
  const activate = (): void => {
    dispatch('set_active_level', { levelId: level.id });
    const doc = useStore.getState().document;
    const ids = Object.values(doc.building?.elements ?? {}).flatMap((element) =>
      'levelId' in element && element.levelId === level.id ? element.entityIds : [],
    );
    if (ids.length > 0)
      focusItem(
        entitiesFocus(doc, {
          key: `building:level:${level.id}`,
          label: `${/^level\b/i.test(level.name) ? '' : 'Level '}${level.name} (${level.elevation >= 0 ? '+' : ''}${level.elevation} ${units})`,
          color: LEVEL_COLOR,
          ids,
        }),
      );
  };
  const toggle = (next: Exclude<RowMode, null>): void => setMode(mode === next ? null : next);
  return (
    <>
      <ListRow
        selected={active}
        current={active}
        testId={`level-row-${level.id}`}
        onSelect={activate}
        actions={
          <>
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
            <DeleteButton
              icon="close"
              size={12}
              label={`Delete level ${level.name}`}
              title="Delete level (and its elements)"
              onDelete={() => dispatch('delete_level', { levelId: level.id, deleteElements: true })}
            />
          </>
        }
      >
        {/* The accessible name is the visible text plus this prefix (WCAG label-in-name). */}
        <span className="visually-hidden">Activate level</span> <span className="panel__row-main">{level.name}</span>{' '}
        <span className="panel__row-meta">
          +{level.elevation} {units} · h {level.height}
        </span>
      </ListRow>
      {mode === 'edit' && (
        <li>
          <LevelEditForm level={level} units={units} onDone={() => setMode(null)} />
        </li>
      )}
      {mode === 'copy' && (
        <li>
          <CopyLevelForm source={level} targets={levels.filter((candidate) => candidate.id !== level.id)} onDone={() => setMode(null)} />
        </li>
      )}
    </>
  );
}

function AddLevelForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [name, setName] = useState('');
  const [height, setHeight] = useState('');
  const units = useStore((s) => s.document.units);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    dispatch('add_level', { ...optionalText('name', name), ...optionalNumber('height', height) });
    setName('');
  };

  return (
    <form className="building-inline-form building-level-form" onSubmit={handleSubmit} aria-label="Add level">
      <input
        type="text"
        placeholder="Level name, e.g. First floor"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="New level name"
      />
      <input
        type="number"
        placeholder={`Storey height (${units})`}
        value={height}
        onChange={(event) => setHeight(event.target.value)}
        aria-label="New level height"
        title={`Floor-to-floor height in ${units}; leave empty for the default (3 m)`}
      />
      <button type="submit" className="btn btn--ghost btn--sm">
        Add level
      </button>
    </form>
  );
}

export function LevelsSection(): React.ReactElement {
  const activeLevelId = useStore((s) => s.document.building?.activeLevelId);
  const units = useStore((s) => s.document.units);
  const levels = useBuildingLevels();
  return (
    <PanelSection
      title="Levels"
      step={1}
      hint="Floors of the building. Click a level to make it active: new elements go on the active level."
      count={levels.length}
      countLabel={`${levels.length} levels`}
      testId="building-levels"
    >
      <ul className="panel__list" aria-label="Building levels">
        {[...levels].reverse().map((level) => (
          <LevelRow key={level.id} level={level} active={level.id === activeLevelId} units={units} levels={levels} />
        ))}
      </ul>
      <AddLevelForm />
    </PanelSection>
  );
}
