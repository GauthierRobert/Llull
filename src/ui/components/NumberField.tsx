/**
 * @layer ui/components
 *
 * NumberField — `<input type="number">` for a numeric value owned elsewhere (a store field). It
 * keeps the typed text locally so intermediate input ("0.", "-", "1e-") is never rewritten, and
 * reports only finite parsed numbers through `onValueChange`. An external change of `value`
 * replaces the text unless it already parses to that value. Its `ref` (a React 19 prop) reaches the
 * `<input>`.
 */

import React, { useState } from 'react';
import { parseNumber } from '@ui/numberText';

type NativeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange'
>;

interface NumberFieldProps extends NativeInputProps {
  value: number;
  onValueChange: (value: number) => void;
  ref?: React.Ref<HTMLInputElement>;
}

export function NumberField({
  value,
  onValueChange,
  ref,
  ...inputProps
}: NumberFieldProps): React.ReactElement {
  const [text, setText] = useState(String(value));
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (parseNumber(text) !== value) setText(String(value));
  }
  return (
    <input
      {...inputProps}
      ref={ref}
      type="number"
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseNumber(next);
        if (parsed !== undefined) {
          onValueChange(parsed);
        }
      }}
    />
  );
}
