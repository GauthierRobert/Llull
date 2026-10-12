/**
 * @layer ui/panels/building
 * LevelSelect — native select over building levels (by id, shown by name), optionally with a blank
 * first choice and a visible field label.
 */

import React from 'react';
import type { BuildingLevel } from '@core/model/building';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { PairSelect } from '@ui/panels/OptionSelect';

interface LevelSelectProps {
  levels: ReadonlyArray<BuildingLevel>;
  value: string;
  /** Accessible name (and visible label when `showLabel`). */
  label: string;
  /** Show `label` as a `field` label around the select. */
  showLabel?: boolean;
  /** Text of the empty first choice (value ''); omitted = none. */
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
    <LabeledSelect
      label={label}
      value={value}
      options={options}
      {...optional}
      testId={testId}
      onChange={onChange}
    />
  ) : (
    <PairSelect
      value={value}
      options={options}
      label={label}
      {...optional}
      testId={testId}
      title={title}
      onChange={onChange}
    />
  );
}
