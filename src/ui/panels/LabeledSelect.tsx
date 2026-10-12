/**
 * @layer ui/panels
 * LabeledSelect — the `field` label + native select over `[value, text]` options, with an optional
 * blank first choice.
 */

import React from 'react';
import { PairSelect } from '@ui/panels/OptionSelect';

interface LabeledSelectProps {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  /** Text of an empty first choice (value ''); omitted = no empty choice. */
  blankLabel?: string;
  testId?: string | undefined;
  onChange: (value: string) => void;
}

export function LabeledSelect({
  label,
  value,
  options,
  blankLabel,
  testId,
  onChange,
}: LabeledSelectProps): React.ReactElement {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <PairSelect
        value={value}
        options={options}
        label={label}
        {...(blankLabel !== undefined ? { blankLabel } : {})}
        testId={testId}
        onChange={onChange}
      />
    </label>
  );
}
