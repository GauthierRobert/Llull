/** create_clash_issues (plant 09 VIS §5.8, TR-VIS-40): one review issue per clash of a read-only source command, framed by a saved viewpoint. */

import { fromMm } from '../../model/units';
import { ISSUE_PRIORITIES, type ReviewIssue, type ReviewModel, type Viewpoint } from '../../model/review';
import { canonicalJson } from '../../lib/canonicalJson';
import { nameUuid } from '../../lib/nameUuid';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { execute } from '../execute';
import { clashBox, clashCamera, clashEntityIds, clashKeyOf, clashesOf, unionBounds, type ClashRecord } from './clashFraming';
import { mintReviewId, reviewOf, reviewRejection } from './reviewModel';

/** Most clashes turned into issues by one run (the rest are counted in `data.truncated`). */
const MAX_CLASH_ISSUES = 500;

const describeClash = (clash: ClashRecord): string =>
  `${clash.kind} clash ${clash.a} x ${clash.b}, depth ${Number(clash.depthMm.toFixed(3))} mm`;

/**
 * @affects adds 1 issue (status open, type Clash) and 1 viewpoint per new clash to doc.review (affected: the issue ids, new and existing); metaHistory
 * @invariant idempotent on clashKey: a re-run creates nothing for a clash that has an issue, rewrites only its description (depth), never its status, history or comments, so no human gate is crossed; the source runs read-only
 * @failure unknown source, source refused / returned no clashes[] -> VIS_CLASH_SOURCE_INVALID; negative or non-finite margin -> VIS_ISSUE_INVALID
 */
export const createClashIssues = defineCommand({
  name: 'create_clash_issues',
  description:
    'Turn clashes into review issues (BCF topics). Runs the read-only `source` ("check_clashes" for building / plant elements, "check_assembly" for solids ' +
    'FPR_PAIR_HARD / FPR_PAIR_CONTAINED pairs) with `sourceParams`, and opens one issue per clash (type "Clash", status open, labels clash + kind) with a saved ' +
    'viewpoint framing the pair: iso camera (1,-1,1), perspective 45 degrees, box = overlap of the two bounding boxes (or the gap between them) grown by ' +
    '`margin` mm, the two parts selected. Idempotent: a clash that already has an issue (clashKey "clash:<a>,<b>|<kind>") is not created again, only its ' +
    'description depth is refreshed; status, history and comments are never touched (closing stays a human act). data { created, unchanged, updated, skipped, ' +
    'truncated, issueIds }. At most 500 clashes per run. Errors: VIS_CLASH_SOURCE_INVALID, VIS_ISSUE_INVALID. Then export_bcf to send them.',
  annotations: { metaHistory: true },
  params: z.object({
    source: z
      .enum(['check_clashes', 'check_assembly'])
      .describe(
        'Read-only command that finds the clashes: "check_clashes" (building / plant elements) or "check_assembly" (solid parts; needs a kernel).',
      ),
    sourceParams: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Params passed to the source command, e.g. { "levelId": "level-1" } or { "tolerance": 10 }.'),
    margin: z.number().optional().describe('Millimetres added around the clash box on every side before framing. Default 500.'),
    priority: z.enum(ISSUE_PRIORITIES).optional().describe('Priority of the new issues: "low", "normal" (default), "high" or "critical".'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const margin = params.margin ?? 500;
    if (!Number.isFinite(margin) || margin < 0)
      return reviewRejection(
        doc,
        'create_clash_issues',
        'VIS_ISSUE_INVALID',
        'margin must be a number of millimetres >= 0',
        [],
        ['margin'],
      );
    const invalid = (why: string): CommandResult =>
      reviewRejection(doc, 'create_clash_issues', 'VIS_CLASH_SOURCE_INVALID', why, [], ['source']);
    if (ctx === undefined || ctx.registry(params.source) === undefined) return invalid(`'${params.source}' is not registered in this host`);
    const source = execute(doc, params.source, params.sourceParams ?? {}, ctx);
    if (source.rejected === true) return invalid(`'${params.source}' refused: ${source.summary}`);
    const found = clashesOf(doc, params.source, source.data);
    if (found === null) return invalid(`'${params.source}' returned no clashes[] (${source.summary})`);
    const marginUnits = fromMm(doc, margin);
    let review: ReviewModel = reviewOf(doc);
    const byKey = new Map(
      Object.values(review.issues).flatMap((issue) => (issue.clashKey === undefined ? [] : [[issue.clashKey, issue.id] as const])),
    );
    const issueIds: string[] = [];
    const counts = { created: 0, unchanged: 0, updated: 0, skipped: 0 };
    for (const clash of found.slice(0, MAX_CLASH_ISSUES)) {
      const key = clashKeyOf(clash);
      const existingId = byKey.get(key);
      const description = describeClash(clash);
      if (existingId !== undefined) {
        const existing = review.issues[existingId];
        if (existing !== undefined && !issueIds.includes(existingId)) {
          issueIds.push(existingId);
          if (existing.description === description) counts.unchanged += 1;
          else {
            counts.updated += 1;
            review = { ...review, issues: { ...review.issues, [existingId]: { ...existing, description } } };
          }
        }
        continue;
      }
      const idsA = clashEntityIds(doc, clash.a);
      const idsB = clashEntityIds(doc, clash.b);
      const boxA = unionBounds(doc, idsA);
      const boxB = unionBounds(doc, idsB);
      if (boxA === null || boxB === null) {
        counts.skipped += 1;
        continue;
      }
      const entityIds = [...new Set([...idsA, ...idsB])];
      const [viewpointId, afterViewpoint] = mintReviewId(review, 'vp');
      const camera = clashCamera(clashBox(boxA, boxB), marginUnits);
      const viewpoint: Viewpoint = {
        id: viewpointId,
        guid: nameUuid(`llull-viewpoint|${viewpointId}|${canonicalJson(camera)}`),
        name: `Clash ${clash.a} x ${clash.b}`,
        camera,
        selection: entityIds,
      };
      const [issueId, afterIssue] = mintReviewId(afterViewpoint, 'iss');
      const title = `Clash: ${clash.a} x ${clash.b} (${clash.kind})`;
      const issue: ReviewIssue = {
        id: issueId,
        guid: nameUuid(`llull-issue|${issueId}|${title}`),
        title,
        type: 'Clash',
        priority: params.priority ?? 'normal',
        status: 'open',
        description,
        labels: ['clash', clash.kind],
        viewpointIds: [viewpointId],
        entityIds,
        clashKey: key,
        history: [],
      };
      review = {
        ...afterIssue,
        viewpoints: { ...afterIssue.viewpoints, [viewpointId]: viewpoint },
        viewpointOrder: [...afterIssue.viewpointOrder, viewpointId],
        issues: { ...afterIssue.issues, [issueId]: issue },
        issueOrder: [...afterIssue.issueOrder, issueId],
      };
      byKey.set(key, issueId);
      issueIds.push(issueId);
      counts.created += 1;
    }
    const truncated = Math.max(0, found.length - MAX_CLASH_ISSUES);
    const summary =
      `create_clash_issues: ${found.length} clash(es) from ${params.source}: ${counts.created} issue(s) created, ${counts.unchanged} unchanged, ` +
      `${counts.updated} refreshed, ${counts.skipped} skipped (part without geometry)${truncated > 0 ? `, ${truncated} over the ${MAX_CLASH_ISSUES} limit` : ''}` +
      `${issueIds.length > 0 ? `: ${issueIds.join(', ')}` : ''}.`;
    const data = { ...counts, truncated, issueIds };
    if (counts.created === 0 && counts.updated === 0) return { document: doc, summary, affected: [], data };
    return { ...changed({ ...doc, review }, summary, issueIds), data };
  },
});
