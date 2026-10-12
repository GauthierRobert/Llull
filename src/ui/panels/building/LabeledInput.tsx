/**
 * @layer ui/panels/building
 * LabeledInput — the `field` label + input pair of the building forms (text or number).
 */

import React from 'react';

interface LabeledInputProps {
  label: React.ReactNode;
  type: 'text' | 'number';
  value: string;
  onChange: (value: string) => void;
  /** Tooltip on the whole field. */
  title?: string;
  testId?: string;
}

export function LabeledInput({
  label,
  type,
  value,
  onChange,
  title,
  testId,
}: LabeledInputProps): React.ReactElement {
  return (
    <label className="field" title={title}>
      <span className="field__label">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
    </label>
  );
}

/** `{ [key]: number }` when `text` is a finite number that differs from `original`, else `{}`. */
export function changedNumber(key: string, text: string, original: number): Record<string, number> {
  return text !== String(original) && Number.isFinite(Number(text)) ? { [key]: Number(text) } : {};
}
