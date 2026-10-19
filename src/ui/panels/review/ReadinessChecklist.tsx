// Readiness checklist (FR-FPR-50): one row per check with status icon + word, the key value, the threshold with its source, expandable
// findings and an Explain link. Solver self-checks sit under their own sub-header, apart from "Matches reality".

import React, { useState } from 'react';
import { Icon } from '@ui/components/Icon';
import { StatusMark } from './StatusMark';
import { formatThreshold, headlineAccuracy, headlineValue, itemStatusLabel, type ChecklistRowModel } from './checklist';
import { AccuracyBadge } from './AccuracyBadge';

interface ChecklistRowProps {
  readonly row: ChecklistRowModel;
  readonly onExplain: (findingKey: string) => void;
}

function ChecklistRow({ row, onExplain }: ChecklistRowProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const value = row.headline === null ? null : headlineValue(row.headline);
  const accuracy = row.headline === null ? null : headlineAccuracy(row.headline);
  const threshold = row.headline === null ? null : formatThreshold(row.headline);
  const panelId = `checklist-row-${row.id}`;
  return (
    <li className={`checklist-row checklist-row--${row.status}`} data-testid={`checklist-row-${row.id}`}>
      <div className="checklist-row__head">
        <button
          type="button"
          className="checklist-row__toggle"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={row.items.length === 0}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          <span className="checklist-row__label">{row.label}</span>
        </button>
        <StatusMark status={row.status} />
        {row.headline !== null && (
          <button
            type="button"
            className="checklist-row__explain"
            onClick={() => row.headline !== null && onExplain(row.headline.findingKey)}
            aria-label={`Explain ${row.label}`}
          >
            Explain
          </button>
        )}
      </div>
      {(value !== null || threshold !== null) && (
        <p className="checklist-row__detail">
          {value !== null && <span data-testid={`checklist-value-${row.id}`}>{value}</span>}
          {accuracy !== null && <AccuracyBadge accuracy={accuracy} testId={`checklist-accuracy-${row.id}`} />}
          {threshold !== null && <span data-testid={`checklist-threshold-${row.id}`}>{threshold}</span>}
        </p>
      )}
      {open && (
        <ul id={panelId} className="checklist-row__items" aria-label={`${row.label} findings`}>
          {row.items.map((item) => (
            <li key={item.findingKey} className="checklist-row__item">
              <StatusMark status={item.status} label={itemStatusLabel(item)} />
              <code className="checklist-row__code">{item.code}</code>
              <button type="button" className="checklist-row__explain" onClick={() => onExplain(item.findingKey)}>
                Explain
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface ReadinessChecklistProps {
  readonly rows: readonly ChecklistRowModel[];
  readonly onExplain: (findingKey: string) => void;
}

export function ReadinessChecklist({ rows, onExplain }: ReadinessChecklistProps): React.ReactElement {
  const checks = rows.filter((row) => row.group === 'checks');
  const selfchecks = rows.filter((row) => row.group === 'selfchecks');
  return (
    <div className="readiness" data-testid="readiness-checklist">
      <ul className="readiness__list" aria-label="Readiness checks">
        {checks.map((row) => (
          <ChecklistRow key={row.id} row={row} onExplain={onExplain} />
        ))}
      </ul>
      <h4 className="readiness__subheader">Solver self-checks</h4>
      <p className="readiness__note">Verification of the solver itself, not evidence the model matches reality.</p>
      <ul className="readiness__list" aria-label="Solver self-checks">
        {selfchecks.map((row) => (
          <ChecklistRow key={row.id} row={row} onExplain={onExplain} />
        ))}
      </ul>
    </div>
  );
}
