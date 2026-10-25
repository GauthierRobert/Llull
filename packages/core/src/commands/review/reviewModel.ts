/** Shared helpers of the model-review commands (plant 09 VIS): the review section, review ids and the coded refusals (§7). */

import type { CadDocument } from '../../model/types';
import { createReviewModel, type ReviewModel } from '../../model/review';
import { tableRejection } from '../noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_CAMERA_INVALID: 'give finite eye / direction / up, up not parallel to direction, fovDeg in (0, 180) or viewHeight > 0',
  VIS_VIEWPOINT_NOT_FOUND: 'list the viewpoints with list_viewpoints',
  VIS_VIEWPOINT_IN_USE: 'delete the walkthroughs (delete_walkthrough) / issues (delete_review_issue) that reference the viewpoint first',
  VIS_WALKTHROUGH_INVALID: 'give 2..500 keys of one projection with seconds > 0, and fps × duration within maxFrames',
  VIS_WALKTHROUGH_NOT_FOUND: 'create one with create_walkthrough',
  VIS_ENTITY_NOT_FOUND: 'pass ids from find_entities',
  VIS_ISSUE_INVALID: 'give a non-empty title and a due date as YYYY-MM-DD',
  VIS_ISSUE_NOT_FOUND: 'create one with create_review_issue',
  VIS_SECTION_BOX_INVALID: 'give min < max on every axis (optionally rotationZ), or 1..6 planes with non-zero normals, not both',
  VIS_SECTION_BOX_NOT_FOUND: 'create one with set_section_box',
  VIS_SECTION_BOX_IN_USE: 'update or delete the viewpoints that reference the section box first (update_viewpoint, delete_viewpoint)',
  VIS_MARKUP_INVALID:
    'give 2..256 points (screen: [x, y] inside [0, 1]; world: [x, y, z] finite), at least 2 for line / polyline / arrow, at least 3 for cloud, 2 for ellipse (bounding corners), 1 for text; text needs text',
  VIS_MARKUP_NOT_FOUND: 'list the markups with get_viewpoint',
  VIS_COLOUR_INVALID: 'use #rrggbb',
  VIS_PROFILE_NOT_FOUND: 'list the profiles with check_display, or create one with define_colour_profile',
  VIS_ISSUE_STATUS_INVALID:
    'follow the workflow open <-> in_progress <-> resolved -> closed (closing and re-opening a closed issue are human acts)',
  VIS_COMMENT_INVALID: 'give a non-empty text',
  VIS_HUMAN_GATE:
    'a human signs the act in the desktop app (review_act_payload gives the bytes) and the signature goes in confirmation; an agent prepares the act and hands over',
  VIS_RENDER_BUDGET: 'lower width / height / fps or the frame count',
  VIS_RENDER_INVALID: 'perspective and native renders are raster-only; perspective takes no turntable / isolate / section',
  NATIVE_TOOL_MISSING:
    "use renderer 'reference' (the default), or run in the llull CLI / desktop app with llull-compute built (cargo build --release in solver/)",
  NATIVE_JOB_FAILED: "retry with renderer 'reference'; the job log is in the summary",
};

export const reviewRejection = tableRejection(REMEDIATION);

export function reviewOf(doc: CadDocument): ReviewModel {
  return doc.review ?? createReviewModel();
}

/** The next review id `<prefix>-<n>` and the review section with its counter advanced. */
export function mintReviewId(review: ReviewModel, prefix: 'vp' | 'wt' | 'iss' | 'sb' | 'mk' | 'cm'): [string, ReviewModel] {
  return [`${prefix}-${review.nextNumber}`, { ...review, nextNumber: review.nextNumber + 1 }];
}
