// Lens card on the model: name + kind + a Properties toggle, then one pill per dimension. Click a pill to retype it;
// Enter applies, Escape cancels. Expression-driven dimensions (=param) are read-only and show ƒ.

import React, { useState } from 'react';
import { classNames } from '@ui/classNames';
import { Icon } from '@ui/components/Icon';
import { parseNumber } from '@ui/numberText';
import type { LensDimension } from './lensDimensions';

interface LensPillProps {
  dimension: LensDimension;
  unit: string;
  onCommit: (dimension: LensDimension, value: number) => void;
}

function formatValue(value: number): string {
  return String(Number(value.toFixed(4)));
}

function LensPill({ dimension, unit, onCommit }: LensPillProps): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const name = `${dimension.key}${dimension.index === undefined ? '' : ` ${dimension.label}`}`;

  if (dimension.value === null) {
    return (
      <span
        className="lens-pill lens-pill--driven"
        title={`${name} = ${dimension.expression ?? ''}`}
        aria-label={`${name}: ${dimension.expression ?? ''}`}
      >
        <span className="lens-pill__label">{dimension.label}</span>ƒ
      </span>
    );
  }

  const current = dimension.value;
  if (draft === null) {
    return (
      <button
        type="button"
        className="lens-pill"
        aria-label={`Edit ${name}: ${formatValue(current)} ${unit}`}
        onClick={() => setDraft(formatValue(current))}
      >
        <span className="lens-pill__label">{dimension.label}</span>
        {formatValue(current)}
      </button>
    );
  }

  const commit = (): void => {
    const value = parseNumber(draft);
    setDraft(null);
    if (value !== undefined && value > 0 && value !== current) onCommit(dimension, value);
  };
  return (
    <label className={classNames('lens-pill', 'lens-pill--editing')}>
      <span className="lens-pill__label">{dimension.label}</span>
      <input
        className="lens-pill__input"
        aria-label={name}
        inputMode="decimal"
        value={draft}
        size={Math.max(draft.length, 2)}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setDraft(null);
        }}
      />
      <span className="lens-pill__unit">{unit}</span>
    </label>
  );
}

interface LensPillsProps {
  name: string;
  kind: string;
  unit: string;
  dimensions: readonly LensDimension[];
  /** Last refusal summary of an edit, shown under the pills. */
  refusal: string | null;
  propertiesOpen: boolean;
  onToggleProperties: () => void;
  onCommit: (dimension: LensDimension, value: number) => void;
}

export function LensPills({
  name,
  kind,
  unit,
  dimensions,
  refusal,
  propertiesOpen,
  onToggleProperties,
  onCommit,
}: LensPillsProps): React.ReactElement {
  const propertiesLabel = propertiesOpen ? 'Hide properties' : 'Show properties';
  return (
    <div className="lens" role="group" aria-label={`Dimensions of ${name}`}>
      <div className="lens__tag">
        <span className="lens__name">{name}</span>
        <span className="lens__kind">{kind}</span>
        <button
          type="button"
          className="lens__properties"
          aria-label={propertiesLabel}
          aria-pressed={propertiesOpen}
          title={propertiesLabel}
          onClick={onToggleProperties}
        >
          <Icon name="panelRight" size={13} />
        </button>
      </div>
      {dimensions.length > 0 && (
        <div className="lens__pills">
          {dimensions.map((dimension) => (
            <LensPill key={dimension.id} dimension={dimension} unit={unit} onCommit={onCommit} />
          ))}
        </div>
      )}
      {refusal !== null && (
        <p className="lens__refusal" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
}
