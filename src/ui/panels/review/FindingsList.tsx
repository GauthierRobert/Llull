// Findings list (FR-FPR-51 / 58): filter by type, severity and reviewer status; sort by severity or value; group by part. The reviewer
// status + comment of each finding go out through onDisposition (the panel dispatches set_review_disposition). An `accepted` fail still
// reads "fail (accepted)": it is recorded, never a pass.

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import { StatusMark } from './StatusMark';
import { findingFocus } from './findingLocations';
import { findingTitle, formatThreshold, headlineAccuracy, headlineValue, itemStatusLabel } from './checklist';
import { AccuracyBadge } from './AccuracyBadge';
import { filterFindings, flattenFindings, groupFindings, reviewerStatusOf, sortFindings, type Finding } from './findings';
import { useReviewStore } from './reviewStore';
import {
  CHECK_NAMES,
  DISPOSITION_STATUSES,
  type CheckName,
  type CheckResult,
  type CheckStatus,
  type DispositionStatus,
} from './reviewTypes';

const CHECK_LABEL: Readonly<Record<CheckName, string>> = {
  assembly: 'Assembly',
  mechanism: 'Mechanism',
  motion_clearance: 'Motion clearance',
  dynamics: 'Dynamics',
};
const REVIEWER_LABEL: Readonly<Record<DispositionStatus, string>> = {
  not_reviewed: 'Not reviewed',
  relevant: 'Relevant',
  irrelevant: 'Irrelevant',
  accepted: 'Accepted',
};
const SEVERITIES: readonly CheckStatus[] = ['fail', 'warn', 'not_run', 'info', 'pass'];

export interface DispositionChange {
  readonly findingKey: string;
  readonly status: DispositionStatus;
  readonly comment: string;
  /** Hash of the check the finding came from: the disposition goes stale when the check's inputs change. */
  readonly inputsHash: string;
}

interface FindingRowProps {
  readonly finding: Finding;
  readonly editable: boolean;
  readonly onDisposition: (change: DispositionChange) => void;
  readonly onExplain: (findingKey: string) => void;
}

function FindingRow({ finding, editable, onDisposition, onExplain }: FindingRowProps): React.ReactElement {
  const { item } = finding;
  const [comment, setComment] = useState(item.disposition?.comment ?? '');
  const status = reviewerStatusOf(item);
  const value = headlineValue(item);
  const accuracy = headlineAccuracy(item);
  const threshold = formatThreshold(item);
  const document = useStore((s) => s.document);
  const focusItem = useFocusItem();
  const focus = findingFocus(document, finding);
  const focused = useIsFocused(focus.key);
  return (
    <li className={focused ? 'finding finding--focused' : 'finding'} data-testid={`finding-${item.findingKey}`}>
      <div className="finding__head">
        <StatusMark status={item.status} label={itemStatusLabel(item)} />
        <span className="finding__title">{findingTitle(item.code)}</span>
        <code className="finding__code">{item.code}</code>
        {item.disposition?.by === 'agent' && <span className="finding__badge">agent</span>}
        {item.disposition?.stale === true && <span className="finding__badge finding__badge--stale">stale</span>}
        <button
          type="button"
          className="checklist-row__explain"
          aria-pressed={focused}
          title="Show this finding on the model"
          data-testid={`finding-show-${item.findingKey}`}
          onClick={() => focusItem(focus)}
        >
          Show
        </button>
        <button type="button" className="checklist-row__explain" onClick={() => onExplain(item.findingKey)}>
          Explain
        </button>
      </div>
      <p className="finding__meta">
        <span>{CHECK_LABEL[finding.check]}</span>
        {item.ids.length > 0 && <span>{item.ids.join(', ')}</span>}
        {value !== null && <span>{value}</span>}
        {accuracy !== null && <AccuracyBadge accuracy={accuracy} testId={`finding-accuracy-${item.findingKey}`} />}
        {threshold !== null && <span>{threshold}</span>}
      </p>
      <p className="finding__remediation">{item.remediation}</p>
      <div className="finding__review">
        <select
          aria-label={`Reviewer status for ${item.code}`}
          value={status}
          disabled={!editable}
          onChange={(e) => {
            const next = DISPOSITION_STATUSES.find((s) => s === e.target.value);
            if (next !== undefined) onDisposition({ findingKey: item.findingKey, status: next, comment, inputsHash: finding.inputsHash });
          }}
        >
          {DISPOSITION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {REVIEWER_LABEL[s]}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="finding__comment"
          aria-label={`Comment for ${item.code}`}
          placeholder="Comment"
          value={comment}
          disabled={!editable}
          onChange={(e) => setComment(e.target.value)}
          onBlur={() => {
            if (comment !== (item.disposition?.comment ?? ''))
              onDisposition({ findingKey: item.findingKey, status, comment, inputsHash: finding.inputsHash });
          }}
        />
      </div>
    </li>
  );
}

interface FilterSelectProps<T extends string> {
  readonly label: string;
  readonly value: T | 'all';
  readonly options: ReadonlyArray<readonly [T, string]>;
  readonly onChange: (value: T | 'all') => void;
}

function FilterSelect<T extends string>({ label, value, options, onChange }: FilterSelectProps<T>): React.ReactElement {
  return (
    <label className="findings__filter">
      <span className="panel__row-meta">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(options.find(([key]) => key === e.target.value)?.[0] ?? 'all')}
        data-testid={`findings-filter-${label.toLowerCase().replace(/ /g, '-')}`}
      >
        <option value="all">All</option>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

interface FindingsListProps {
  readonly checks: readonly CheckResult[];
  /** False while set_review_disposition is not registered: the reviewer controls are disabled. */
  readonly dispositionAvailable: boolean;
  readonly onDisposition: (change: DispositionChange) => void;
  readonly onExplain: (findingKey: string) => void;
}

export function FindingsList({ checks, dispositionAvailable, onDisposition, onExplain }: FindingsListProps): React.ReactElement {
  const checkFilter = useReviewStore((s) => s.checkFilter);
  const severityFilter = useReviewStore((s) => s.severityFilter);
  const reviewerFilter = useReviewStore((s) => s.reviewerFilter);
  const sort = useReviewStore((s) => s.sort);
  const group = useReviewStore((s) => s.group);
  const { setCheckFilter, setSeverityFilter, setReviewerFilter, setSort, setGroup } = useReviewStore.getState();
  const all = flattenFindings(checks);
  const shown = sortFindings(filterFindings(all, { check: checkFilter, severity: severityFilter, reviewer: reviewerFilter }), sort);
  const groups = groupFindings(shown, group);
  return (
    <div className="findings" data-testid="findings-list">
      <div className="findings__controls">
        <FilterSelect
          label="Type"
          value={checkFilter}
          options={CHECK_NAMES.map((n) => [n, CHECK_LABEL[n]] as const)}
          onChange={setCheckFilter}
        />
        <FilterSelect
          label="Severity"
          value={severityFilter}
          options={SEVERITIES.map((s) => [s, s.replace('_', ' ')] as const)}
          onChange={setSeverityFilter}
        />
        <FilterSelect
          label="Reviewer"
          value={reviewerFilter}
          options={DISPOSITION_STATUSES.map((s) => [s, REVIEWER_LABEL[s]] as const)}
          onChange={setReviewerFilter}
        />
        <label className="findings__filter">
          <span className="panel__row-meta">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value === 'value' ? 'value' : 'severity')} data-testid="findings-sort">
            <option value="severity">Severity</option>
            <option value="value">Value</option>
          </select>
        </label>
        <label className="findings__filter">
          <span className="panel__row-meta">Group</span>
          <select value={group} onChange={(e) => setGroup(e.target.value === 'part' ? 'part' : 'none')} data-testid="findings-group">
            <option value="none">None</option>
            <option value="part">By part</option>
          </select>
        </label>
      </div>
      <p className="panel__row-meta" role="status" data-testid="findings-count">
        {shown.length} of {all.length} findings
      </p>
      {!dispositionAvailable && shown.length > 0 && (
        <p className="findings__note" data-testid="findings-disposition-unavailable">
          Reviewer status and comments are not available yet.
        </p>
      )}
      {groups.map((g) => (
        <section key={g.part || 'all'} className="findings__group" aria-label={g.part === '' ? undefined : `Part ${g.part}`}>
          {g.part !== '' && <h4 className="readiness__subheader">{g.part}</h4>}
          <ul className="findings__list">
            {g.findings.map((finding) => (
              <FindingRow
                key={`${g.part}:${finding.item.findingKey}`}
                finding={finding}
                editable={dispositionAvailable}
                onDisposition={onDisposition}
                onExplain={onExplain}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
