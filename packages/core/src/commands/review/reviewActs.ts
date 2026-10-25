/**
 * The human acts of the review model and what a human signs for them (09 VIS §5.5). A payload is bound to the whole issue (guid, title, entities,
 * viewpoints, history) through its hash, so a signature made for one issue cannot be replayed on another issue of the same id in another document.
 */

import { jcsJson } from '../../lib/jcs';
import { sha256Hex } from '../../lib/sha256';
import { humanGatePayload } from '../../model/humanGate';
import type { IssueStatus, ReviewIssue } from '../../model/review';

export const STATUS_ACT = 'review:set_issue_status';
export const DELETE_ACT = 'review:delete_review_issue';

export const issueSha256 = (issue: ReviewIssue): string => sha256Hex(jcsJson(issue));

export const statusDetails = (issue: ReviewIssue, to: IssueStatus, reason: string): Record<string, unknown> => ({
  from: issue.status,
  to,
  reason: reason.trim(),
  historyLength: issue.history.length,
  issueSha256: issueSha256(issue),
});

export const statusPayload = (issue: ReviewIssue, to: IssueStatus, reason: string, nonce: string): string =>
  humanGatePayload(STATUS_ACT, [issue.id], statusDetails(issue, to, reason), nonce);

export const deleteDetails = (issue: ReviewIssue): Record<string, unknown> => ({ issueSha256: issueSha256(issue) });

export const deletePayload = (issue: ReviewIssue, nonce: string): string =>
  humanGatePayload(DELETE_ACT, [issue.id], deleteDetails(issue), nonce);

/** The issue as it was just before history entry `index` was appended (what the signer of that entry saw). */
export function issueBefore(issue: ReviewIssue, index: number): ReviewIssue {
  const previous = index === 0 ? undefined : issue.history[index - 1];
  return { ...issue, status: previous?.status ?? 'open', history: issue.history.slice(0, index) };
}
