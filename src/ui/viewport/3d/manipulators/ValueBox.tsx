// On-canvas number box next to a drag handle: shows the live value, accepts typing. Enter commits, Escape cancels, blur keeps the
// text (the session stays open). Presentation + param gathering only; the caller commits through the command layer.

import { useEffect, useRef, useState } from 'react';
import { parseValueText } from './manipulatorMath';

interface ValueBoxProps {
  label: string;
  unit: string;
  value: number;
  /** Typed number (live, before Enter). */
  onChange: (value: number) => void;
  onCommit: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}

/** Trim float noise from a dragged value for display. */
function formatValue(value: number): string {
  return String(Number(value.toPrecision(6)));
}

export function ValueBox({ label, unit, value, onChange, onCommit, onCancel, autoFocus = false }: ValueBoxProps): React.ReactElement {
  const [text, setText] = useState(() => formatValue(value));
  const editing = useRef(false);

  // A drag moves the value from outside; typing wins while the field has focus.
  useEffect(() => {
    if (!editing.current) setText(formatValue(value));
  }, [value]);

  return (
    <label className="value-box">
      <span className="value-box__label">{label}</span>
      <input
        className="value-box__input"
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        aria-label={`${label} (${unit})`}
        value={text}
        onFocus={(e) => {
          editing.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          editing.current = false;
          setText(formatValue(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseValueText(e.target.value);
          if (parsed !== null) onChange(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            onCommit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <span className="value-box__unit">{unit}</span>
    </label>
  );
}
