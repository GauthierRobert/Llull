/** @layer ui/panels Presentational field primitives for the properties inspector. */

import React, { useRef, useState } from 'react';

const AXES = ['x', 'y', 'z'] as const;

function formatNumber(n: number): string {
  return n.toFixed(3);
}

/** Shortest text for an editable field: 3 decimals at most, no trailing zeros, no "-0". */
function formatEditableNumber(n: number): string {
  const rounded = Number(n.toFixed(3));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function PropRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="props-row">
      <span className="props-key">{label}</span>
      <div className="props-value">{children}</div>
    </div>
  );
}

export function ScalarRow({
  label,
  value,
  unit,
}: {
  label: string;
  value: number;
  unit?: string;
}): React.ReactElement {
  return (
    <PropRow label={label}>
      <span className="props-number">
        {formatNumber(value)}
        {unit !== undefined && <span className="props-unit">{unit}</span>}
      </span>
    </PropRow>
  );
}

/** Text input that reports its value on Enter or blur; Esc reverts. */
export function CommitInput({
  value,
  label,
  className,
  placeholder,
  inputMode,
  autoFocus = false,
  onCommit,
  onFinish,
}: {
  value: string;
  label: string;
  className: string;
  placeholder?: string;
  inputMode?: 'decimal';
  autoFocus?: boolean;
  onCommit: (text: string) => void;
  /** Called after every blur (committed, unchanged or cancelled) so a caller can close the editor. */
  onFinish?: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const [seenValue, setSeenValue] = useState(value);
  const cancelledRef = useRef(false);
  if (value !== seenValue) {
    setSeenValue(value);
    setDraft(value);
  }
  return (
    <input
      className={className}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      inputMode={inputMode}
      spellCheck={false}
      autoFocus={autoFocus}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        // Escape sets the flag before blurring: the blur handler would otherwise still see the
        // typed draft in its closure and commit it.
        const cancelled = cancelledRef.current;
        cancelledRef.current = false;
        if (cancelled) setDraft(value);
        else if (draft !== value) {
          onCommit(draft);
          // A rejected edit (unparseable number) leaves the stored value as is: show it again.
          // An accepted one changes `value`, which the prop sync above turns into the new draft.
          setDraft(value);
        }
        onFinish?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancelledRef.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

interface AxisFieldsProps {
  values: readonly number[];
  /** Accessible label prefix; required with `onAxisCommit`. */
  label?: string;
  /** When set the triple is editable and receives the parsed finite value only. */
  onAxisCommit?: (axisIndex: number, value: number) => void;
}

/** X/Y/Z triple; editable fields are keyed by stored value so they reset when the document changes. */
export function AxisFields({ values, label, onAxisCommit }: AxisFieldsProps): React.ReactElement {
  return (
    <div className="axis-fields">
      {values.slice(0, 3).map((n, i) => {
        const axis = AXES[i] ?? 'z';
        const letter = (
          <span className={`axis-field__letter axis-field__letter--${axis}`} aria-hidden="true">
            {axis.toUpperCase()}
          </span>
        );
        if (onAxisCommit === undefined) {
          return (
            <span key={axis} className="axis-field">
              {letter}
              <span className="axis-field__value">{formatNumber(n)}</span>
            </span>
          );
        }
        const text = formatEditableNumber(n);
        return (
          <label key={`${axis}:${text}`} className="axis-field axis-field--editable">
            {letter}
            <CommitInput
              className="axis-field__input"
              label={`${label ?? ''} ${axis.toUpperCase()}`}
              value={text}
              inputMode="decimal"
              onCommit={(raw) => {
                const parsed = Number.parseFloat(raw);
                if (Number.isFinite(parsed)) onAxisCommit(i, parsed);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}
