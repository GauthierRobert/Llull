/** Review comments (plant 09 VIS §4): the discussion on an issue; a comment cites at most one viewpoint (BCF). metaHistory. */

import type { ReviewComment } from '../../model/review';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { mintReviewId, reviewOf, reviewRejection } from './reviewModel';

/**
 * @affects adds 1 comment to doc.review (affected: [id], id `cm-<n>`); metaHistory
 * @failure unknown issue -> VIS_ISSUE_NOT_FOUND; unknown viewpoint -> VIS_VIEWPOINT_NOT_FOUND; empty text -> VIS_COMMENT_INVALID
 */
export const addReviewComment = defineCommand({
  name: 'add_review_comment',
  description:
    'Comment on a review issue (iss-<n>), optionally citing the saved viewpoint (vp-<n>) that shows the point. Returns the id (cm-<n>) in affected[0] and data { id }. ' +
    'Comments are deleted with their issue. Does not add a feature step. Errors: VIS_ISSUE_NOT_FOUND, VIS_VIEWPOINT_NOT_FOUND, VIS_COMMENT_INVALID.',
  annotations: { metaHistory: true },
  params: z.object({
    issueId: z.string().describe('Issue id, e.g. "iss-1".'),
    text: z.string().describe('The comment; not empty.'),
    viewpointId: z.string().optional().describe('Saved viewpoint (vp-<n>) the comment refers to.'),
    author: z
      .enum(['agent', 'human'])
      .optional()
      .describe('Who wrote it, as a label only (not verified). Default "agent"; the UI sends "human".'),
  }),
  run: (doc, params): CommandResult => {
    const review = reviewOf(doc);
    if (review.issues[params.issueId] === undefined)
      return reviewRejection(
        doc,
        'add_review_comment',
        'VIS_ISSUE_NOT_FOUND',
        `no issue '${params.issueId}'`,
        [params.issueId],
        ['issueId'],
      );
    const text = params.text.trim();
    if (text.length === 0) return reviewRejection(doc, 'add_review_comment', 'VIS_COMMENT_INVALID', 'the text is empty', [], ['text']);
    if (params.viewpointId !== undefined && review.viewpoints[params.viewpointId] === undefined)
      return reviewRejection(
        doc,
        'add_review_comment',
        'VIS_VIEWPOINT_NOT_FOUND',
        `no viewpoint '${params.viewpointId}'`,
        [params.viewpointId],
        ['viewpointId'],
      );
    const [id, next] = mintReviewId(review, 'cm');
    const comment: ReviewComment = {
      id,
      issueId: params.issueId,
      text,
      ...(params.viewpointId === undefined ? {} : { viewpointId: params.viewpointId }),
      author: params.author ?? 'agent',
    };
    const document = { ...doc, review: { ...next, comments: { ...next.comments, [id]: comment } } };
    const result = changed(document, `Added comment ${id} to issue ${params.issueId}.`, [id]);
    return { ...result, data: { id } };
  },
});
