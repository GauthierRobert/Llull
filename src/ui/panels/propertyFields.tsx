import React, { useRef, useState } from 'react';
import { fixedNumber } from '@lib/compactNumber';
import { parseNumber } from '@ui/numberText';

const AXES = ['x', 'y', 'z'] as const;

/** Always 3 decimals. */
function formatReadout(n: number): string {
  return n.toFixed(3);
}

/** ≤ 3 decimals, no trailing zeros, no "-0". */
function formatEditableNumber(n: number): string {
  return fixedNumber(n, 3);
}

export function PropRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="props-row">
      <span className="props-key">{label}</span>
      <div className="props-value">{children}</div>
    </div>
  );
}

export function ScalarRow({ label, value, unit }: { label: string; value: number; unit?: string }): React.ReactElement {
  return (
    <PropRow label={label}>
      <span className="props-number">
        {formatReadout(value)}
        {unit !== undefined && <span className="props-unit">{unit}</span>}
      </span>
    </PropRow>
  );
}

/** Reports on Enter or blur; Esc reverts. */
export function CommitInput({
  value,
  label,
  className,
  placeholder,
  inputMode,
  autoFocus = false,
  onCommit,
  onFinish,
  testId,
  inputProps,
}: {
  value: string;
  label: string;
  className: string;
  placeholder?: string;
  inputMode?: 'decimal';
  autoFocus?: boolean;
  onCommit: (text: string) => void;
  /** After every blur (committed, unchanged or cancelled), e.g. to close the editor. */
  onFinish?: () => void;
  testId?: string;
  /** Native attributes; the editing handlers stay ours. */
  inputProps?: Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'onBlur' | 'onKeyDown' | 'className' | 'placeholder' | 'inputMode'
  >;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const [seenValue, setSeenValue] = useState(value);
  const [focused, setFocused] = useState(false);
  const cancelledRef = useRef(false);
  // External changes (undo, live sync, an agent) replace the draft unless the user is typing.
  if (value !== seenValue && !focused) {
    setSeenValue(value);
    setDraft(value);
  }
  return (
    <input
      {...inputProps}
      data-testid={testId}
      className={className}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      inputMode={inputMode}
      spellCheck={false}
      autoFocus={autoFocus}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        // Set before blurring: the blur handler's closure would otherwise commit the typed draft.
        const cancelled = cancelledRef.current;
        cancelledRef.current = false;
        if (cancelled) setDraft(value);
        else if (draft !== value) {
          onCommit(draft);
          // Rejected edit: show the stored value again (an accepted one arrives via the prop sync above).
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
  /** Required with `onAxisCommit`. */
  label?: string;
  /** Editable when set; receives parsed finite values only. */
  onAxisCommit?: (axisIndex: number, value: number) => void;
}

/** Editable fields are keyed by stored value so they reset when the document changes. */
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
              <span className="axis-field__value">{formatReadout(n)}</span>
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
                const parsed = parseNumber(raw);
                if (parsed !== undefined) onAxisCommit(i, parsed);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}
