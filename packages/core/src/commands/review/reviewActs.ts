/**
 * The human acts of the review model and what a human signs for them (09 VIS §5.5). A payload is bound to the whole issue (guid, title, entities,
 * viewpoints, history) through its hash and to the document through its uid (VIS-ID), so a signature made for one issue cannot be replayed on another issue of
 * the same id, nor on a copy of the issue in another document. The cited entities' content is NOT bound (decision in plant 09 §12.7).
 */

import { jcsJson } from '../../lib/jcs';
import { sha256Hex } from '../../lib/sha256';
import { humanGatePayload } from '../../model/humanGate';
import type { IssueStatus, ReviewIssue } from '../../model/review';

export const STATUS_ACT = 'review:set_issue_status';
export const DELETE_ACT = 'review:delete_review_issue';

/** An issue whose fields a human signature may cover (a human history entry) or whose status moved: only the gated workflow may change it. */
export const isProtectedIssue = (issue: ReviewIssue): boolean =>
  issue.status !== 'open' || issue.history.some((entry) => entry.by === 'human');

export const issueSha256 = (issue: ReviewIssue): string => sha256Hex(jcsJson(issue));

export const statusDetails = (issue: ReviewIssue, to: IssueStatus, reason: string, documentUid: string): Record<string, unknown> => ({
  documentUid,
  from: issue.status,
  to,
  reason: reason.trim(),
  historyLength: issue.history.length,
  issueSha256: issueSha256(issue),
});

export const statusPayload = (issue: ReviewIssue, to: IssueStatus, reason: string, nonce: string, documentUid: string): string =>
  humanGatePayload(STATUS_ACT, [issue.id], statusDetails(issue, to, reason, documentUid), nonce);

export const deleteDetails = (issue: ReviewIssue, documentUid: string): Record<string, unknown> => ({
  documentUid,
  issueSha256: issueSha256(issue),
});

export const deletePayload = (issue: ReviewIssue, nonce: string, documentUid: string): string =>
  humanGatePayload(DELETE_ACT, [issue.id], deleteDetails(issue, documentUid), nonce);

/**
 * The issue as it was just before history entry `index` was appended (what the signer of that entry saw).
 * @invariant no command edits an issue's title, entityIds, viewpointIds, assignedTo or dueDate after creation, so the rebuilt state equals what was signed; a future
 *   editing command must gate the edit (human act) or record it in the history
 */
export function issueBefore(issue: ReviewIssue, index: number): ReviewIssue {
  const previous = index === 0 ? undefined : issue.history[index - 1];
  return { ...issue, status: previous?.status ?? 'open', history: issue.history.slice(0, index) };
}
