/**
 * Issue workflow (plant 09 VIS §5.5, TR-VIS-15) with the human gate: closing an issue and re-opening a closed one are approval acts, cleared only by a
 * signature a trusted human key made over this exact act (`humanGate`, the signing port of 09 PLM: `ctx.humanSignature`). Nothing a caller says about
 * itself counts; `history[].by` is 'human' only when a signature verified.
 */

import { humanGate, humanGatePayload } from '../../model/humanGate';
import { ISSUE_STATUSES, type IssueHistoryEntry, type IssueStatus, type ReviewIssue } from '../../model/review';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, report } from '../noop';
import { reviewOf, reviewRejection } from './reviewModel';

const ACT = 'review:set_issue_status';

/** Statuses an issue may move to from `from`; a transition into or out of `closed` is a human act. */
const NEXT: Readonly<Record<IssueStatus, readonly IssueStatus[]>> = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved: ['open', 'in_progress', 'closed'],
  closed: ['open'],
};

export const isHumanTransition = (from: IssueStatus, to: IssueStatus): boolean => from === 'closed' || to === 'closed';

/** What a human signs for a transition: bound to the issue, its current status and history length, the target and the reason (a replay of another state fails). */
export function issueStatusPayload(issue: ReviewIssue, to: IssueStatus, reason: string, nonce: string): string {
  return humanGatePayload(ACT, [issue.id], { from: issue.status, to, reason: reason.trim(), historyLength: issue.history.length }, nonce);
}

const confirmationParam = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'HUMAN SIGNATURE, required to close an issue and to re-open a closed one: { alg: "Ed25519", keyId, publicKey, signature, nonce } made by a human with a ' +
      'TRUSTED signing key over review_act_payload(issueId, status, reason, nonce). An agent has none: it prepares the act and hands over (VIS_HUMAN_GATE).',
  );

/**
 * @affects sets doc.review.issues[issueId].status and appends one history entry (affected: [issueId]); metaHistory
 * @invariant workflow open <-> in_progress <-> resolved -> closed -> open; closing and re-opening closed need a verified human signature bound to (issue, from, to, reason, history length); by is 'human' only then
 * @failure unknown issue -> VIS_ISSUE_NOT_FOUND; transition outside the workflow, same status or empty reason -> VIS_ISSUE_STATUS_INVALID; no / bad / foreign signature -> VIS_HUMAN_GATE
 */
export const setIssueStatus = defineCommand({
  name: 'set_issue_status',
  description:
    'Move a review issue (iss-<n>) along its workflow: open <-> in_progress <-> resolved, then closed. The reason is recorded in the issue history. ' +
    'HUMAN GATE: closing an issue (approving the resolution) and re-opening a closed one need `confirmation`, a signature a human made with a trusted key in the ' +
    'desktop app over the bytes review_act_payload returns; an agent gets VIS_HUMAN_GATE, so mark the issue resolved and hand over. A valid signature on a ' +
    'non-gated move is recorded as a human act. data { status, history }. Does not add a feature step. Errors: VIS_ISSUE_NOT_FOUND, VIS_ISSUE_STATUS_INVALID, VIS_HUMAN_GATE.',
  annotations: { metaHistory: true },
  params: z.object({
    issueId: z.string().describe('Issue id, e.g. "iss-2".'),
    status: z.enum(ISSUE_STATUSES).describe('Target status: "open", "in_progress", "resolved" or "closed" (human gate).'),
    reason: z.string().describe('Why, e.g. "skid moved, clash cleared". Recorded in the history; not empty.'),
    confirmation: confirmationParam,
  }),
  run: (doc, { issueId, status, reason, confirmation }, ctx): CommandResult => {
    const review = reviewOf(doc);
    const issue = review.issues[issueId];
    if (issue === undefined)
      return reviewRejection(doc, 'set_issue_status', 'VIS_ISSUE_NOT_FOUND', `no issue '${issueId}'`, [issueId], ['issueId']);
    const why = reason.trim();
    if (why.length === 0)
      return reviewRejection(doc, 'set_issue_status', 'VIS_ISSUE_STATUS_INVALID', 'the reason is empty', [issueId], ['reason']);
    if (!NEXT[issue.status].includes(status))
      return reviewRejection(
        doc,
        'set_issue_status',
        'VIS_ISSUE_STATUS_INVALID',
        `${issue.status} -> ${status} is not a transition (from ${issue.status}: ${NEXT[issue.status].join(', ')})`,
        [issueId],
        ['status'],
      );
    const gated = isHumanTransition(issue.status, status);
    let entry: IssueHistoryEntry = { status, by: 'agent', reason: why };
    if (gated || confirmation !== undefined) {
      const outcome = humanGate(ctx?.humanSignature ?? null, ACT, [issueId], confirmation, {
        from: issue.status,
        to: status,
        reason: why,
        historyLength: issue.history.length,
      });
      if (!outcome.cleared)
        return reviewRejection(
          doc,
          'set_issue_status',
          'VIS_HUMAN_GATE',
          `${issue.status} -> ${status} is a human act: ${outcome.reason}`,
          [issueId],
          ['confirmation'],
        );
      entry = { status, by: 'human', reason: why, signatureId: outcome.signatureId, signer: outcome.signer };
    }
    const next: ReviewIssue = { ...issue, status, history: [...issue.history, entry] };
    const document = { ...doc, review: { ...review, issues: { ...review.issues, [issueId]: next } } };
    const result = changed(
      document,
      `Issue ${issueId}: ${issue.status} -> ${status} by ${entry.by}${entry.signer === undefined ? '' : ` (${entry.signer})`}.`,
      [issueId],
    );
    return { ...result, data: { status, history: next.history } };
  },
});

/** @affects nothing — read-only; data { act, payloadSha256, from, to, ... } */
export const reviewActPayload = defineCommand({
  name: 'review_act_payload',
  description:
    'The SHA-256 a human signs to authorize set_issue_status on an issue for a given target status, reason and nonce (the nonce is chosen by the signer and must ' +
    'also be inside `confirmation`). The payload is bound to the issue, its current status and history length, so a signature cannot be replayed on another ' +
    'state. data { act, issueId, from, to, reason, nonce, payloadSha256 }. Read-only. Errors: VIS_ISSUE_NOT_FOUND, VIS_ISSUE_STATUS_INVALID.',
  annotations: { readOnly: true },
  params: z.object({
    issueId: z.string().describe('Issue id, e.g. "iss-2".'),
    status: z.enum(ISSUE_STATUSES).describe('Target status the human will sign for.'),
    reason: z.string().describe('The reason that will be passed to set_issue_status (it is part of what is signed).'),
    nonce: z.string().min(1).describe('A fresh non-empty string chosen by the signer; the same nonce goes in `confirmation.nonce`.'),
  }),
  run: (doc, { issueId, status, reason, nonce }): CommandResult => {
    const issue = reviewOf(doc).issues[issueId];
    if (issue === undefined)
      return reviewRejection(doc, 'review_act_payload', 'VIS_ISSUE_NOT_FOUND', `no issue '${issueId}'`, [issueId], ['issueId']);
    if (!NEXT[issue.status].includes(status))
      return reviewRejection(
        doc,
        'review_act_payload',
        'VIS_ISSUE_STATUS_INVALID',
        `${issue.status} -> ${status} is not a transition`,
        [issueId],
        ['status'],
      );
    const payloadSha256 = issueStatusPayload(issue, status, reason, nonce);
    return report(doc, `Payload to sign for ${issueId} ${issue.status} -> ${status}: ${payloadSha256}.`, {
      act: ACT,
      issueId,
      from: issue.status,
      to: status,
      reason: reason.trim(),
      nonce,
      payloadSha256,
    });
  },
});
