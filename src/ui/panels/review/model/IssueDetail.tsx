// One review issue: its viewpoints, comments and the status move. Closing / re-opening a closed issue and deleting are human acts: each goes
// through SignActDialog and the command gets the signature (`confirmation`), never a flag.

import React, { useState } from 'react';
import { deletePayload, statusPayload } from '@core/commands/review/reviewActs';
import type { IssueStatus, ReviewIssue, ReviewModel } from '@core/model/review';
import { SignActDialog, type SignActRequest } from '@ui/components/SignActDialog';
import { StatusChip } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { useRedlineStore } from '@ui/store/redlineStore';
import { STATUS_LABEL, STATUS_TONE, commentsOf, isHumanMove, nextStatuses, signedBy } from './issueModel';

interface Props {
  issue: ReviewIssue;
  review: ReviewModel;
}

export function IssueDetail({ issue, review }: Props): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const redlineViewpoint = useRedlineStore((s) => s.viewpointId);
  const [comment, setComment] = useState('');
  const [target, setTarget] = useState<IssueStatus | ''>('');
  const [reason, setReason] = useState('');
  const [signing, setSigning] = useState<SignActRequest | null>(null);
  const comments = commentsOf(review, issue.id);
  const signer = signedBy(issue);
  const moves = nextStatuses(issue.status);

  const addComment = (): void => {
    if (comment.trim() === '') return;
    dispatch('add_review_comment', {
      issueId: issue.id,
      text: comment,
      author: 'human',
      ...(redlineViewpoint !== null && issue.viewpointIds.includes(redlineViewpoint) ? { viewpointId: redlineViewpoint } : {}),
    });
    setComment('');
  };

  const move = (): void => {
    if (target === '' || reason.trim() === '') return;
    const params = { issueId: issue.id, status: target, reason: reason.trim() };
    if (!isHumanMove(issue.status, target)) {
      dispatch('set_issue_status', params);
    } else {
      setSigning({
        title: target === 'closed' ? `Close ${issue.id}` : `Re-open ${issue.id}`,
        summary: `Sign to move ${issue.id} "${issue.title}" from ${STATUS_LABEL[issue.status]} to ${STATUS_LABEL[target]}: ${params.reason}`,
        act: 'set_issue_status',
        payload: (nonce) => statusPayload(issue, target, params.reason, nonce),
        onSigned: (confirmation) => dispatch('set_issue_status', { ...params, confirmation }),
      });
    }
    setTarget('');
    setReason('');
  };

  const remove = (): void =>
    setSigning({
      title: `Delete ${issue.id}`,
      summary: `Sign to delete issue ${issue.id} "${issue.title}" and its comments. Deleting an issue is a human act.`,
      act: 'delete_review_issue',
      payload: (nonce) => deletePayload(issue, nonce),
      onSigned: (confirmation) => dispatch('delete_review_issue', { id: issue.id, confirmation }),
    });

  return (
    <div className="issue-detail" data-testid="issue-detail" aria-label={`Issue ${issue.id}`}>
      {issue.description !== undefined && <p className="issue-detail__text">{issue.description}</p>}
      {signer !== null && (
        <p className="panel__row-meta" data-testid="issue-signed">
          Signed by {signer}: this issue is frozen against imports.
        </p>
      )}
      {issue.viewpointIds.length > 0 && (
        <div className="issue-detail__views" role="group" aria-label="Viewpoints">
          {issue.viewpointIds.map((id) => (
            <button
              key={id}
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                dispatch('apply_viewpoint', { id });
                useRedlineStore.getState().setViewpointId(id);
              }}
              title={`Go to ${review.viewpoints[id]?.name ?? id}`}
            >
              {review.viewpoints[id]?.name ?? id}
            </button>
          ))}
        </div>
      )}
      <ul className="issue-detail__comments" aria-label="Comments">
        {comments.map((entry) => (
          <li key={entry.id} className="issue-detail__comment" data-testid="issue-comment">
            <span className="panel__row-meta">{entry.importedAuthor ?? entry.author}</span> {entry.text}
          </li>
        ))}
        {comments.length === 0 && <li className="panel__row-meta">No comments yet.</li>}
      </ul>
      <div className="issue-detail__form">
        <input
          type="text"
          className="field__input"
          value={comment}
          placeholder="Add a comment…"
          aria-label={`Comment on ${issue.id}`}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && addComment()}
        />
        <button type="button" className="btn btn--sm" disabled={comment.trim() === ''} onClick={addComment}>
          Comment
        </button>
      </div>
      <div className="issue-detail__form">
        <StatusChip tone={STATUS_TONE[issue.status]} text={STATUS_LABEL[issue.status]} />
        <select
          className="field__input"
          aria-label={`Move ${issue.id} to`}
          value={target}
          onChange={(event) => setTarget(event.target.value as IssueStatus | '')}
        >
          <option value="">Move to…</option>
          {moves.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
              {isHumanMove(issue.status, status) ? ' (signed)' : ''}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="field__input"
          value={reason}
          placeholder="Reason"
          aria-label={`Reason for moving ${issue.id}`}
          onChange={(event) => setReason(event.target.value)}
        />
        <button type="button" className="btn btn--sm btn--primary" disabled={target === '' || reason.trim() === ''} onClick={move}>
          {target !== '' && isHumanMove(issue.status, target) ? 'Sign and move' : 'Move'}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={remove} aria-label={`Delete issue ${issue.id}`}>
          Delete
        </button>
      </div>
      {signing !== null && <SignActDialog request={signing} onClose={() => setSigning(null)} />}
    </div>
  );
}
