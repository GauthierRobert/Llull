/** check_review (plant 09 VIS §7, TR-VIS-16, AF-20): read-only status of the review data with stable VIS_* codes, ids, paths and remediation. */

import { ISSUE_STATUSES } from '../../model/review';
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

/**
 * @affects nothing — read-only
 * @invariant status is fail when any error row exists (a closed issue without a human signature in its history), else warn when any warn row exists, else pass; rows are one per code in a fixed order, ids in creation order
 */
export const checkReview = defineCommand({
  name: 'check_review',
  description:
    'Check the model-review data: data { status "pass" | "warn" | "fail", issues[{ code, severity, ids, paths, message, remediation }], counts }. Codes: ' +
    'VIS_ISSUE_OPEN (info: issue open or in progress), VIS_ISSUE_AWAITING_APPROVAL (warn: resolved, waiting for a human to close it), VIS_ISSUE_ENTITY_MISSING ' +
    '(warn: an unclosed issue cites deleted entities), VIS_VIEWPOINT_STALE (warn: a viewpoint selects or lists deleted entities), VIS_HUMAN_GATE (error: a closed ' +
    'issue has no human signature in its history). Read-only; run it before handing a review over.',
  annotations: { readOnly: true },
  params: z.object({
    includeInfo: z.boolean().optional().describe('false: leave the info rows (VIS_ISSUE_OPEN) out of `issues`. Default true.'),
  }),
  run: (doc, { includeInfo }): CommandResult => {
    const review = reviewOf(doc);
    const issues = review.issueOrder.map((id) => review.issues[id]).filter((issue) => issue !== undefined);
    const missing = (ids: readonly string[]): string[] => ids.filter((id) => doc.entities[id] === undefined);
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
        ids: issues.filter((issue) => issue.status === 'closed' && issue.history.at(-1)?.by !== 'human').map((issue) => issue.id),
        paths: ['review.issues[].history'],
        message: 'closed issues whose closing is not a signed human act',
        remediation: 'a human re-opens and closes them with a signature (set_issue_status); the file was edited outside the commands',
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
