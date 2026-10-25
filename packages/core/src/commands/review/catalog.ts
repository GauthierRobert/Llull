/** Model review: interference intents, grounded parts, reviewer dispositions (checks in inspect/ and dynamics/); viewpoints, section boxes, markups, walkthroughs, issues, comments and the issue workflow (plant 09 VIS). */

import { commandCatalog } from '../schema';
import { setReviewDisposition } from './dispositions';
import { setPartGrounded } from './grounding';
import { allowInterference, removeInterferenceIntent } from './intents';
import { deleteViewpoint, listViewpoints, saveViewpoint } from './viewpoints';
import { createWalkthrough, deleteWalkthrough } from './walkthroughs';
import { createReviewIssue, deleteReviewIssue } from './issues';
import { setIssueStatus, reviewActPayload } from './issueStatus';
import { addReviewComment } from './comments';
import { checkReview } from './checkReview';
import { addMarkup, deleteMarkup } from './markups';
import { deleteSectionBox, sectionBoxReport, setSectionBox } from './sectionBoxes';
import { applyViewpoint, getViewpoint, updateViewpoint } from './viewpointEdit';

export const reviewCommands = commandCatalog(
  allowInterference,
  removeInterferenceIntent,
  setPartGrounded,
  setReviewDisposition,
  saveViewpoint,
  listViewpoints,
  deleteViewpoint,
  createWalkthrough,
  deleteWalkthrough,
  createReviewIssue,
  deleteReviewIssue,
  getViewpoint,
  updateViewpoint,
  applyViewpoint,
  setSectionBox,
  deleteSectionBox,
  sectionBoxReport,
  addMarkup,
  deleteMarkup,
  addReviewComment,
  setIssueStatus,
  reviewActPayload,
  checkReview,
);
