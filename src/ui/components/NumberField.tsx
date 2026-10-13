/**
 * Number input over an external value: keeps the typed text ("0.", "-", "1e-" never rewritten), reports finite numbers
 * only; an external `value` change replaces the text unless it already parses to it. `ref` reaches the <input>.
 */

import React, { useState } from 'react';
import { parseNumber } from '@ui/numberText';

type NativeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'>;

interface NumberFieldProps extends NativeInputProps {
  value: number;
  onValueChange: (value: number) => void;
  ref?: React.Ref<HTMLInputElement>;
}

export function NumberField({ value, onValueChange, ref, ...inputProps }: NumberFieldProps): React.ReactElement {
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
