// Select over building levels (id → name), optional blank choice and visible label.

import React from 'react';
import type { BuildingLevel } from '@core/model/building';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { PairSelect } from '@ui/panels/OptionSelect';

interface LevelSelectProps {
  levels: ReadonlyArray<BuildingLevel>;
  value: string;
  /** Accessible name (visible with `showLabel`). */
  label: string;
  showLabel?: boolean;
  /** Empty first choice (value ''); omitted = none. */
  blankLabel?: string;
  testId?: string | undefined;
  title?: string | undefined;
  onChange: (levelId: string) => void;
}

export function LevelSelect({
  levels,
  value,
  label,
  showLabel = false,
  blankLabel,
  testId,
  title,
  onChange,
}: LevelSelectProps): React.ReactElement {
  const options = levels.map((level): readonly [string, string] => [level.id, level.name]);
  const optional = blankLabel !== undefined ? { blankLabel } : {};
  return showLabel ? (
    <LabeledSelect label={label} value={value} options={options} {...optional} testId={testId} onChange={onChange} />
  ) : (
    <PairSelect value={value} options={options} label={label} {...optional} testId={testId} title={title} onChange={onChange} />
  );
}
