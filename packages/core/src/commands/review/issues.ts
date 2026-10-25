/** Review issues (plant 09 VIS §4, BCF Topic): create and delete; the status workflow is in issueStatus.ts, comments in comments.ts. */

import { ISSUE_PRIORITIES, type ReviewIssue } from '../../model/review';
import { nameUuid } from '../../lib/nameUuid';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { isoDateProblem } from '../../lib/isoDate';
import { mintReviewId, reviewOf, reviewRejection } from './reviewModel';

/**
 * @affects adds 1 issue to doc.review (affected: [id], id `iss-<n>`), status open; metaHistory
 * @failure empty title / bad due date -> VIS_ISSUE_INVALID; unknown viewpoint -> VIS_VIEWPOINT_NOT_FOUND; unknown entity -> VIS_ENTITY_NOT_FOUND
 */
export const createReviewIssue = defineCommand({
  name: 'create_review_issue',
  description:
    'Open a model-review issue (a BCF topic): title, type (e.g. "Clash", "Issue", "Request"), priority, optional description, labels, assignedTo, dueDate (YYYY-MM-DD), ' +
    'the viewpoints that show it (save_viewpoint) and the entities it concerns. Returns the id (iss-<n>) in affected[0] and data { id, guid }. ' +
    'export_bcf writes the issues as a BCF 3.0 file with snapshots. Does not add a feature step. Errors: VIS_ISSUE_INVALID, ' +
    'VIS_VIEWPOINT_NOT_FOUND, VIS_ENTITY_NOT_FOUND. The issue starts open; move it with set_issue_status, discuss it with add_review_comment.',
  annotations: { metaHistory: true },
  params: z.object({
    title: z.string().describe('Short title, e.g. "Line 102 clashes with the cable tray".'),
    type: z.string().optional().describe('BCF topic type, e.g. "Clash", "Issue", "Request". Default "Issue".'),
    priority: z.enum(ISSUE_PRIORITIES).optional().describe('"low", "normal" (default), "high" or "critical".'),
    description: z.string().optional().describe('Longer description (BCF Description).'),
    labels: z.array(z.string()).optional().describe('Free labels (BCF Labels).'),
    assignedTo: z.string().optional().describe('Who should act on it (BCF AssignedTo), e.g. a user id or an e-mail address.'),
    dueDate: z.string().optional().describe('Due date as YYYY-MM-DD (BCF DueDate).'),
    viewpointIds: z.array(z.string()).optional().describe('Saved viewpoints showing the issue (the first is the BCF default viewpoint).'),
    entityIds: z.array(z.string()).optional().describe('Entities the issue concerns (selected in the BCF viewpoints).'),
  }),
  run: (doc, params): CommandResult => {
    const title = params.title.trim();
    if (title.length === 0) return reviewRejection(doc, 'create_review_issue', 'VIS_ISSUE_INVALID', 'title is empty', [], ['title']);
    const dueProblem = params.dueDate === undefined ? null : isoDateProblem(params.dueDate);
    if (dueProblem !== null) return reviewRejection(doc, 'create_review_issue', 'VIS_ISSUE_INVALID', dueProblem, [], ['dueDate']);
    const review = reviewOf(doc);
    const viewpointIds = [...new Set(params.viewpointIds ?? [])];
    const entityIds = [...new Set(params.entityIds ?? [])];
    const missingViews = viewpointIds.filter((id) => review.viewpoints[id] === undefined);
    if (missingViews.length > 0)
      return reviewRejection(
        doc,
        'create_review_issue',
        'VIS_VIEWPOINT_NOT_FOUND',
        `unknown viewpoint(s) ${missingViews.join(', ')}`,
        missingViews,
      );
    const missingEntities = entityIds.filter((id) => doc.entities[id] === undefined);
    if (missingEntities.length > 0)
      return reviewRejection(
        doc,
        'create_review_issue',
        'VIS_ENTITY_NOT_FOUND',
        `unknown entit(ies) ${missingEntities.join(', ')}`,
        missingEntities,
      );
    const [id, next] = mintReviewId(review, 'iss');
    const issue: ReviewIssue = {
      id,
      guid: nameUuid(`llull-issue|${id}|${title}`),
      title,
      type: params.type ?? 'Issue',
      priority: params.priority ?? 'normal',
      status: 'open',
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.assignedTo !== undefined ? { assignedTo: params.assignedTo } : {}),
      ...(params.dueDate !== undefined ? { dueDate: params.dueDate } : {}),
      labels: params.labels ?? [],
      viewpointIds,
      entityIds,
      history: [],
    };
    const document = { ...doc, review: { ...next, issues: { ...next.issues, [id]: issue }, issueOrder: [...next.issueOrder, id] } };
    const result = changed(document, `Opened issue ${id} "${title}" (${issue.priority}, ${viewpointIds.length} viewpoint(s)).`, [id]);
    return { ...result, data: { id, guid: issue.guid } };
  },
});

/**
 * @affects removes 1 issue and its comments from doc.review (affected: [id]); metaHistory
 * @failure unknown id -> VIS_ISSUE_NOT_FOUND
 */
export const deleteReviewIssue = defineCommand({
  name: 'delete_review_issue',
  description:
    'Delete a review issue (iss-<n>); its viewpoints stay (delete_viewpoint is allowed once no issue or walkthrough uses them). ' +
    'Unknown id: VIS_ISSUE_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true, destructive: true },
  params: z.object({ id: z.string().describe('Issue id, e.g. "iss-4".') }),
  run: (doc, { id }): CommandResult => {
    const review = reviewOf(doc);
    if (review.issues[id] === undefined)
      return reviewRejection(doc, 'delete_review_issue', 'VIS_ISSUE_NOT_FOUND', `no issue '${id}'`, [id]);
    const issues = Object.fromEntries(Object.entries(review.issues).filter(([key]) => key !== id));
    const comments = Object.fromEntries(Object.entries(review.comments).filter(([, comment]) => comment.issueId !== id));
    const dropped = Object.keys(review.comments).length - Object.keys(comments).length;
    const document = { ...doc, review: { ...review, issues, comments, issueOrder: review.issueOrder.filter((key) => key !== id) } };
    return changed(document, `Deleted issue ${id}${dropped > 0 ? ` and its ${dropped} comment(s)` : ''}.`, [id]);
  },
});
