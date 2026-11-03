// Issues of the model review (document.review.issues): the list with status, priority, assignee and clash marks, a form for a new issue,
// "find clashes" (create_clash_issues), BCF in / out and the detail of the selected issue. Every change is a command.

import React, { useState } from 'react';
import { ISSUE_PRIORITIES, type ReviewModel } from '@core/model/review';
import { PanelEmpty, PanelSection, StatusChip } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { useRedlineStore } from '@ui/store/redlineStore';
import { BcfActions } from './BcfActions';
import { IssueDetail } from './IssueDetail';
import { STATUS_LABEL, STATUS_TONE, orderedIssues } from './issueModel';

type ClashSource = 'check_clashes' | 'check_assembly';

export function IssuesSection({ review }: { review: ReviewModel | undefined }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const selection = useStore((s) => s.document.selection);
  const redlineViewpoint = useRedlineStore((s) => s.viewpointId);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<(typeof ISSUE_PRIORITIES)[number]>('normal');
  const [assignee, setAssignee] = useState('');
  const [source, setSource] = useState<ClashSource>('check_clashes');
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const issues = orderedIssues(review);
  const opened = review === undefined || openId === null ? undefined : review.issues[openId];

  const create = (): void => {
    if (title.trim() === '') return;
    dispatch('create_review_issue', {
      title,
      priority,
      ...(assignee.trim() === '' ? {} : { assignedTo: assignee.trim() }),
      ...(selection.length > 0 ? { entityIds: selection } : {}),
      ...(redlineViewpoint !== null ? { viewpointIds: [redlineViewpoint] } : {}),
    });
    setTitle('');
    setAssignee('');
  };

  return (
    <PanelSection title="Issues" count={issues.length} countLabel={`${issues.length} issues`} testId="review-issues">
      <div className="issue-form">
        <input
          type="text"
          className="field__input"
          value={title}
          placeholder="New issue title…"
          aria-label="New issue title"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
        />
        <select
          className="field__input"
          aria-label="Issue priority"
          value={priority}
          onChange={(event) => setPriority(event.target.value as typeof priority)}
        >
          {ISSUE_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="field__input"
          value={assignee}
          placeholder="Assign to"
          aria-label="Assign to"
          onChange={(event) => setAssignee(event.target.value)}
        />
        <button type="button" className="btn btn--sm btn--primary" disabled={title.trim() === ''} onClick={create}>
          Add issue
        </button>
      </div>
      <p className="panel__row-meta">
        {selection.length > 0
          ? `${selection.length} selected entit${selection.length === 1 ? 'y' : 'ies'} attach to the new issue.`
          : 'Select entities to attach them.'}
      </p>
      <div className="issue-form">
        <select
          className="field__input"
          aria-label="Clash source"
          value={source}
          onChange={(event) => setSource(event.target.value as ClashSource)}
        >
          <option value="check_clashes">Element clashes</option>
          <option value="check_assembly">Assembly overlaps</option>
        </select>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => dispatch('create_clash_issues', { source }, { onResult: (result) => setStatus(result.summary) })}
        >
          Issues from clashes
        </button>
      </div>
      <BcfActions issueIds={issues.map((issue) => issue.id)} />
      {status !== '' && (
        <p className="panel__row-meta" role="status" data-testid="clash-status">
          {status}
        </p>
      )}
      {issues.length === 0 ? (
        <PanelEmpty icon="review" message="No issues yet." hint="Add one above, find clashes, or import a BCF file." compact />
      ) : (
        <ul className="panel__list issue-list" aria-label="Issues">
          {issues.map((issue) => (
            <li
              key={issue.id}
              className={`panel__row issue-row${openId === issue.id ? ' panel__row--selected' : ''}`}
              data-testid={`issue-${issue.id}`}
            >
              <button
                type="button"
                className="building-row-btn"
                aria-expanded={openId === issue.id}
                aria-label={`Issue ${issue.id}: ${issue.title}`}
                onClick={() => setOpenId(openId === issue.id ? null : issue.id)}
              >
                <StatusChip tone={STATUS_TONE[issue.status]} text={STATUS_LABEL[issue.status]} />
                <span className="panel__row-main">{issue.title}</span>
                <span className="panel__row-meta">
                  {issue.priority}
                  {issue.assignedTo === undefined ? '' : ` · ${issue.assignedTo}`}
                  {issue.clashKey === undefined ? '' : ' · clash'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {opened !== undefined && review !== undefined && <IssueDetail issue={opened} review={review} />}
    </PanelSection>
  );
}
