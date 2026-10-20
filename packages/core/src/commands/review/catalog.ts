/** Model review: interference intents, grounded parts, reviewer dispositions (checks in inspect/ and dynamics/); viewpoints, walkthroughs and issues (plant 09 VIS). */

import { commandCatalog } from '../schema';
import { setReviewDisposition } from './dispositions';
import { setPartGrounded } from './grounding';
import { allowInterference, removeInterferenceIntent } from './intents';
import { deleteViewpoint, listViewpoints, saveViewpoint } from './viewpoints';
import { createWalkthrough, deleteWalkthrough } from './walkthroughs';
import { createReviewIssue, deleteReviewIssue } from './issues';

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
);
