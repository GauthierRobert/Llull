/** LabeledInput — the `field` label + input pair of the panel forms (text, number, color or range). */

import React from 'react';

interface LabeledInputProps {
  label: React.ReactNode;
  type: 'text' | 'number' | 'color' | 'range';
  value: string;
  onChange: (value: string) => void;
  /** Tooltip on the whole field. */
  title?: string | undefined;
  testId?: string | undefined;
  /** Accessible name of the input when it differs from the visible label. */
  ariaLabel?: string | undefined;
  placeholder?: string | undefined;
  /** Extra class on the `field` wrapper. */
  className?: string | undefined;
  /** Native attributes of the input (`min`, `max`, `step`, `autoComplete`, `className`…). */
  inputProps?: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'placeholder' | 'aria-label'>;
  /** Rendered after the input (value readout, hex code…). */
  children?: React.ReactNode;
}

export function LabeledInput({
  label,
  type,
  value,
  onChange,
  title,
  testId,
  ariaLabel,
  placeholder,
  className,
  inputProps,
  children,
}: LabeledInputProps): React.ReactElement {
  return (
    <label className={className === undefined ? 'field' : `field ${className}`} title={title}>
      <span className="field__label">{label}</span>
      <input
        {...inputProps}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
      {children}
    </label>
  );
}
