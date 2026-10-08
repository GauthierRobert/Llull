/**
 * @layer ui/components
 *
 * NumberField — `<input type="number">` for a numeric value owned elsewhere (a store field). It
 * keeps the typed text locally so intermediate input ("0.", "-", "1e-") is never rewritten, and
 * reports only finite parsed numbers through `onValueChange`. An external change of `value`
 * replaces the text unless it already parses to that value.
 */

import React, { useState } from 'react';

type NativeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange'
>;

interface NumberFieldProps extends NativeInputProps {
  value: number;
  onValueChange: (value: number) => void;
}

function parseTyped(text: string): number | null {
  if (text.trim() === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function NumberField({
  value,
  onValueChange,
  ...inputProps
}: NumberFieldProps): React.ReactElement {
  const [text, setText] = useState(String(value));
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (parseTyped(text) !== value) setText(String(value));
  }
  return (
    <input
      {...inputProps}
      type="number"
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseTyped(next);
        if (parsed !== null) {
          onValueChange(parsed);
        }
      }}
    />
  );
}
