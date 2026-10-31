import React from 'react';

interface CheckboxGroupProps {
  legend: string;
  options: ReadonlyArray<readonly [string, string]>;
  selected: ReadonlyArray<string>;
  onToggle: (value: string) => void;
}

export function CheckboxGroup({ legend, options, selected, onToggle }: CheckboxGroupProps): React.ReactElement {
  return (
    <fieldset className="checkbox-group">
      <legend className="field__label checkbox-group__legend">{legend}</legend>
      <div className="checkbox-group__options">
        {options.map(([value, label]) => (
          <label key={value} className="checkbox-group__option">
            <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
