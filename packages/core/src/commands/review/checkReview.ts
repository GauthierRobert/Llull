/** check_review (plant 09 VIS §7, TR-VIS-16, AF-20): read-only status of the review data with stable VIS_* codes, ids, paths and remediation. */

import { humanGatePayload } from '../../model/humanGate';
import { documentIdentity } from '../../model/documentUid';
import { ISSUE_STATUSES, type ReviewIssue } from '../../model/review';
import type { HumanSignaturePort } from '../../model/analysis';
import { STATUS_ACT, issueBefore, statusDetails } from './reviewActs';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { reviewOf } from './reviewModel';

type Severity = 'error' | 'warn' | 'info';

interface CheckRow {
  readonly code: string;
  readonly severity: Severity;
  readonly ids: string[];
  readonly paths: string[];
  readonly message: string;
  readonly remediation: string;
}

const humanEntries = (issue: ReviewIssue): number[] => issue.history.flatMap((entry, index) => (entry.by === 'human' ? [index] : []));

type Verdict = 'ok' | 'revoked' | 'invalid' | 'unbound' | 'foreign';

/**
 * Whether the human entry `index` of the issue history verifies against the act rebuilt from the chain, bound to the uid it records (pure: the
 * signature is not spent). Without a verifier only the uid binding is judged.
 * @invariant 'unbound' = no recorded document uid (signed before VIS-ID); 'foreign' = the recorded uid is not this document's, and the signature is
 *   genuine for it (or no verifier is installed); a signature that does not verify for the recorded uid is 'invalid'
 */
function entryVerdict(port: HumanSignaturePort | null, issue: ReviewIssue, index: number, documentUid: string): Verdict {
  const entry = issue.history[index];
  if (entry === undefined) return 'invalid';
  if (entry.documentUid === undefined) return 'unbound';
  const mismatch = entry.documentUid !== documentUid;
  if (port === null) return mismatch ? 'foreign' : 'ok';
  const nonce = entry.proof?.['nonce'];
  if (entry.proof === undefined || typeof nonce !== 'string' || nonce === '') return 'invalid';
  const payload = humanGatePayload(
    STATUS_ACT,
    [issue.id],
    statusDetails(issueBefore(issue, index), entry.status, entry.reason, entry.documentUid),
    nonce,
  );
  if (port.verify(entry.proof, payload) !== null) return mismatch ? 'foreign' : 'ok';
  // Revoked only when the trust store holds a revoked record for exactly this key, the signature is genuine and that record's user is the recorded signer.
  return entry.signer !== undefined && port.revokedSignerOf?.(entry.proof, payload) === entry.signer ? 'revoked' : 'invalid';
}

/**
 * @affects nothing — read-only
 * @invariant status is fail when any error row exists (a closed issue without a human entry, or a human history entry whose signature does not verify against the act rebuilt from the chain), else warn when any warn row exists, else pass; rows are one per code in a fixed order, ids in creation order
 */
export const checkReview = defineCommand({
  name: 'check_review',
  description:
    'Check the model-review data: data { status "pass" | "warn" | "fail", issues[{ code, severity, ids, paths, message, remediation }], counts }. Codes: ' +
    'VIS_ISSUE_OPEN (info: issue open or in progress), VIS_ISSUE_AWAITING_APPROVAL (warn: resolved, waiting for a human to close it), VIS_ISSUE_ENTITY_MISSING ' +
    '(warn: an unclosed issue cites deleted entities), VIS_VIEWPOINT_STALE (warn: a viewpoint selects or lists deleted entities), VIS_HUMAN_GATE (error: a closed ' +
    'issue has no human act in its history, or a human history entry whose signature does not verify when re-checked), VIS_SIGNATURE_UNVERIFIED (warn: human entries exist but this host has no signature verifier), VIS_SIGNER_REVOKED (warn: a genuine signature by a revoked key of the recorded signer), VIS_SIGNATURE_FOREIGN_DOCUMENT (error: a human signature made for another document uid, e.g. an issue copied in), VIS_SIGNATURE_UNBOUND (error: a human signature that records no document uid). Read-only; run it before handing a review over.',
  annotations: { readOnly: true },
  params: z.object({
    includeInfo: z.boolean().optional().describe('false: leave the info rows (VIS_ISSUE_OPEN) out of `issues`. Default true.'),
  }),
  run: (doc, { includeInfo }, ctx): CommandResult => {
    const port = ctx?.humanSignature ?? null;
    const review = reviewOf(doc);
    const issues = review.issueOrder.map((id) => review.issues[id]).filter((issue) => issue !== undefined);
    const missing = (ids: readonly string[]): string[] => ids.filter((id) => doc.entities[id] === undefined);
    const documentUid = documentIdentity(doc);
    const verdicts = (issue: ReviewIssue): Verdict[] => humanEntries(issue).map((index) => entryVerdict(port, issue, index, documentUid));
    const withVerdict = (verdict: Verdict): string[] =>
      issues.filter((issue) => verdicts(issue).includes(verdict)).map((issue) => issue.id);
    const candidates: CheckRow[] = [
      {
        code: 'VIS_ISSUE_OPEN',
        severity: 'info',
        ids: issues.filter((issue) => issue.status === 'open' || issue.status === 'in_progress').map((issue) => issue.id),
        paths: ['review.issues'],
        message: 'issues still open or in progress',
        remediation: 'work on them, or mark them resolved with set_issue_status',
      },
      {
        code: 'VIS_ISSUE_AWAITING_APPROVAL',
        severity: 'warn',
        ids: issues.filter((issue) => issue.status === 'resolved').map((issue) => issue.id),
        paths: ['review.issues'],
        message: 'resolved issues waiting for a human to close them',
        remediation: 'ask the reviewer to close them (set_issue_status with a human signature)',
      },
      {
        code: 'VIS_ISSUE_ENTITY_MISSING',
        severity: 'warn',
        ids: issues.filter((issue) => issue.status !== 'closed' && missing(issue.entityIds).length > 0).map((issue) => issue.id),
        paths: ['review.issues[].entityIds'],
        message: 'unclosed issues that cite deleted entities',
        remediation: 'resolve the issue, or re-create it on the new entities',
      },
      {
        code: 'VIS_VIEWPOINT_STALE',
        severity: 'warn',
        ids: review.viewpointOrder.filter((id) => {
          const viewpoint = review.viewpoints[id];
          return (
            viewpoint !== undefined && missing([...(viewpoint.selection ?? []), ...(viewpoint.visibility?.exceptions ?? [])]).length > 0
          );
        }),
        paths: ['review.viewpoints[].selection', 'review.viewpoints[].visibility'],
        message: 'viewpoints whose selection or visibility lists deleted entities',
        remediation: 'update_viewpoint with the current selection',
      },
      {
        code: 'VIS_HUMAN_GATE',
        severity: 'error',
        ids: issues
          .filter((issue) => (issue.status === 'closed' && issue.history.at(-1)?.by !== 'human') || verdicts(issue).includes('invalid'))
          .map((issue) => issue.id),
        paths: ['review.issues[].history'],
        message: 'issues whose closing is not a human act, or whose recorded human signature is not genuine',
        remediation: 'a human re-opens and closes them with a signature (set_issue_status); the file was edited outside the commands',
      },
      {
        code: 'VIS_SIGNATURE_FOREIGN_DOCUMENT',
        severity: 'error',
        ids: withVerdict('foreign'),
        paths: ['review.issues[].history[].documentUid'],
        message: 'issues with a human signature made for another document (copied in, or the document was cloned and re-identified)',
        remediation: 'discard the copied issue; a human of THIS document re-confirms the move with a signature over this document uid',
      },
      {
        code: 'VIS_SIGNATURE_UNBOUND',
        severity: 'error',
        ids: withVerdict('unbound'),
        paths: ['review.issues[].history[].documentUid'],
        message: 'issues with a human signature that records no document uid (signed before signatures were bound to their document)',
        remediation: 'a human re-opens and re-closes the issue with a new signature (set_issue_status)',
      },
      {
        code: 'VIS_SIGNER_REVOKED',
        severity: 'warn',
        ids: issues.filter((issue) => !verdicts(issue).includes('invalid') && verdicts(issue).includes('revoked')).map((issue) => issue.id),
        paths: ['review.issues[].history'],
        message: 'issues with a genuine human signature by a key the trust store later revoked (same user as the recorded signer)',
        remediation: 'the reviewer re-confirms with a currently trusted key, or accepts the recorded signature as a historical fact',
      },
      {
        code: 'VIS_SIGNATURE_UNVERIFIED',
        severity: 'warn',
        ids: port === null ? issues.filter((issue) => humanEntries(issue).length > 0).map((issue) => issue.id) : [],
        paths: ['review.issues[].history'],
        message: 'issues with human history entries that this host cannot verify (no signature verifier installed)',
        remediation: 'run check_review in the desktop app or the llull CLI, which install the signing port',
      },
    ];
    const rows = candidates.filter((row) => row.ids.length > 0);
    const status = rows.some((row) => row.severity === 'error') ? 'fail' : rows.some((row) => row.severity === 'warn') ? 'warn' : 'pass';
    const counts = {
      viewpoints: review.viewpointOrder.length,
      sectionBoxes: Object.keys(review.sectionBoxes).length,
      markups: Object.keys(review.markups).length,
      walkthroughs: Object.keys(review.walkthroughs).length,
      comments: Object.keys(review.comments).length,
      issues: Object.fromEntries(ISSUE_STATUSES.map((s) => [s, issues.filter((issue) => issue.status === s).length])),
    };
    const shown = rows.filter((row) => includeInfo !== false || row.severity !== 'info');
    const codes = shown.map((row) => `${row.code} x${row.ids.length}`).join(', ');
    return report(
      doc,
      `Review ${status}: ${issues.length} issue(s), ${counts.viewpoints} viewpoint(s)${codes === '' ? '' : `; ${codes}`}.`,
      { status, issues: shown, counts },
    );
  },
});
