/** Shared helpers of the model-review commands (plant 09 VIS): the review section, review ids and the coded refusals (§7). */

import type { CadDocument } from '../../model/types';
import { createReviewModel, type ReviewModel } from '../../model/review';
import { tableRejection } from '../noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_CAMERA_INVALID: 'give finite eye / direction / up, up not parallel to direction, fovDeg in (0, 180) or viewHeight > 0',
  VIS_VIEWPOINT_NOT_FOUND: 'list the viewpoints with list_viewpoints',
  VIS_VIEWPOINT_IN_USE: 'delete the walkthroughs / issues that reference the viewpoint first',
  VIS_WALKTHROUGH_INVALID: 'give 2..500 keys of one projection with seconds > 0, and fps × duration within maxFrames',
  VIS_WALKTHROUGH_NOT_FOUND: 'create one with create_walkthrough',
  VIS_ENTITY_NOT_FOUND: 'pass ids from list_entities',
  VIS_ISSUE_INVALID: 'give a non-empty title',
  VIS_ISSUE_NOT_FOUND: 'create one with create_review_issue',
  VIS_RENDER_BUDGET: 'lower width / height / fps or the frame count',
  NATIVE_TOOL_MISSING:
    "use renderer 'reference' (the default), or run in the llull CLI / desktop app with llull-compute built (cargo build --release in solver/)",
  NATIVE_JOB_FAILED: "retry with renderer 'reference'; the job log is in the summary",
};

export const reviewRejection = tableRejection(REMEDIATION);

export function reviewOf(doc: CadDocument): ReviewModel {
  return doc.review ?? createReviewModel();
}

/** The next review id `<prefix>-<n>` and the review section with its counter advanced. */
export function mintReviewId(review: ReviewModel, prefix: 'vp' | 'wt' | 'iss'): [string, ReviewModel] {
  return [`${prefix}-${review.nextNumber}`, { ...review, nextNumber: review.nextNumber + 1 }];
}
