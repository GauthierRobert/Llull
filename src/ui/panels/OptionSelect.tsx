/** @layer ui/panels Native select over a fixed list of string options (no casts on change). */

import React from 'react';

interface OptionSelectProps<Option extends string> {
  value: Option;
  options: ReadonlyArray<Option>;
  label: string;
  /** Text of each option; defaults to the option value. */
  optionLabel?: (option: Option) => string;
  onChange: (option: Option) => void;
}

export function OptionSelect<Option extends string>({
  value,
  options,
  label,
  optionLabel = (option) => option,
  onChange,
}: OptionSelectProps<Option>): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(event) => {
        const chosen = options.find((option) => option === event.target.value);
        if (chosen !== undefined) onChange(chosen);
      }}
      aria-label={label}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {optionLabel(option)}
        </option>
      ))}
    </select>
  );
}
