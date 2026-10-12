/** @layer ui/panels CheckboxGroup — a legend + one checkbox per `[value, label]` option. */

import React from 'react';

interface CheckboxGroupProps {
  legend: string;
  options: ReadonlyArray<readonly [string, string]>;
  selected: ReadonlyArray<string>;
  onToggle: (value: string) => void;
}

export function CheckboxGroup({
  legend,
  options,
  selected,
  onToggle,
}: CheckboxGroupProps): React.ReactElement {
  return (
    <fieldset className="field">
      <legend className="field__label">{legend}</legend>
      {options.map(([value, label]) => (
        <label key={value} className="field">
          <input
            type="checkbox"
            checked={selected.includes(value)}
            onChange={() => onToggle(value)}
          />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}
