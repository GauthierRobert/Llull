/**
 * @layer ui/panels/building
 *
 * Inline level editors: LevelEditForm → update_level (changed fields only); CopyLevelForm →
 * copy_level_elements (source level's elements to chosen upper levels, optional categories).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel } from '@core/model/building';
import { COPYABLE } from '@aec/building/elements/elements';
import { toggledInList } from '@ui/toggleMember';
import { CheckboxGroup } from '@ui/panels/CheckboxGroup';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { changedNumber, changedText } from '@ui/panels/changedParams';

const CATEGORY_LABELS: Record<(typeof COPYABLE)[number], string> = {
  wall: 'Walls',
  curvedWall: 'Curved walls',
  slab: 'Slabs',
  column: 'Columns',
  beam: 'Beams',
  stair: 'Stairs',
  room: 'Rooms',
  member: 'Steel members',
  footing: 'Footings',
  panel: 'Panels',
  equipment: 'Equipment',
  pipe: 'Pipes',
  tray: 'Cable trays',
};

/** Copyable categories of copy_level_elements (read from the AEC command). */
const COPYABLE_CATEGORIES: ReadonlyArray<readonly [string, string]> = COPYABLE.map(
  (category) => [category, CATEGORY_LABELS[category]] as const,
);

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

  const handleSubmit = (): void => {
    const changes = {
      ...changedText('name', name, level.name),
      ...changedNumber('elevation', elevation, level.elevation),
      ...changedNumber('height', height, level.height),
    };
    if (Object.keys(changes).length > 0)
      dispatch('update_level', { levelId: level.id, ...changes });
    onDone();
  };

  return (
    <CommandForm
      ariaLabel={`Edit level ${level.name}`}
      submitLabel="Save level"
      onSubmit={handleSubmit}
    >
      <LabeledInput label="Level name" type="text" value={name} onChange={setName} />
      <LabeledInput
        label={`Elevation (${units})`}
        type="number"
        value={elevation}
        onChange={setElevation}
      />
      <LabeledInput
        label={`Floor-to-floor height (${units})`}
        type="number"
        value={height}
        onChange={setHeight}
      />
    </CommandForm>
  );
}

interface CopyLevelFormProps {
  source: BuildingLevel;
  targets: ReadonlyArray<BuildingLevel>;
  onDone: () => void;
}

export function CopyLevelForm({ source, targets, onDone }: CopyLevelFormProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  const handleSubmit = (): void => {
    if (targetIds.length === 0) return;
    dispatch('copy_level_elements', {
      sourceLevelId: source.id,
      targetLevelIds: targetIds,
      ...(categories.length > 0 ? { categories } : {}),
    });
    onDone();
  };

  return (
    <CommandForm
      ariaLabel={`Copy level ${source.name}`}
      submitLabel="Copy elements"
      submitDisabled={targetIds.length === 0}
      onSubmit={handleSubmit}
    >
      <CheckboxGroup
        legend="Copy to levels"
        options={targets.map((level): readonly [string, string] => [level.id, level.name])}
        selected={targetIds}
        onToggle={(id) => setTargetIds((previous) => toggledInList(previous, id))}
      />
      <CheckboxGroup
        legend="Categories (none ticked = all)"
        options={COPYABLE_CATEGORIES}
        selected={categories}
        onToggle={(category) => setCategories((previous) => toggledInList(previous, category))}
      />
    </CommandForm>
  );
}
