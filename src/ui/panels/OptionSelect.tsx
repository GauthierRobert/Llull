/** @layer ui/panels Native select over a fixed list of string options (no casts on change). */

import React from 'react';

interface OptionSelectProps<Option extends string> {
  value: Option;
  options: ReadonlyArray<Option>;
  label: string;
  /** Text of each option; defaults to the option value. */
  optionLabel?: (option: Option) => string;
  testId?: string | undefined;
  title?: string | undefined;
  onChange: (option: Option) => void;
}

export function OptionSelect<Option extends string>({
  value,
  options,
  label,
  optionLabel = (option) => option,
  testId,
  title,
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
      title={title}
      data-testid={testId}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {optionLabel(option)}
        </option>
      ))}
    </select>
  );
}

interface PairSelectProps {
  value: string;
  /** `[value, text]` pairs. */
  options: ReadonlyArray<readonly [string, string]>;
  label: string;
  /** Text of an empty first choice (value ''); omitted = no empty choice. */
  blankLabel?: string;
  testId?: string | undefined;
  title?: string | undefined;
  onChange: (value: string) => void;
}

/** Native select over `[value, text]` pairs, optionally with a blank first choice. */
export function PairSelect({ value, options, label, blankLabel, testId, title, onChange }: PairSelectProps): React.ReactElement {
  const texts = new Map(options);
  return (
    <OptionSelect
      value={value}
      options={[...(blankLabel !== undefined ? [''] : []), ...options.map(([v]) => v)]}
      label={label}
      optionLabel={(option) => texts.get(option) ?? blankLabel ?? ''}
      testId={testId}
      title={title}
      onChange={onChange}
    />
  );
}
