/** Model review: prototype interference intents and grounded parts; viewpoints, walkthroughs and issues (plant 09 VIS). */

import { commandCatalog } from '../schema';
import { setPartGrounded } from './grounding';
import { allowInterference, removeInterferenceIntent } from './intents';
import { deleteViewpoint, listViewpoints, saveViewpoint } from './viewpoints';
import { createWalkthrough, deleteWalkthrough } from './walkthroughs';
import { createReviewIssue } from './issues';

export const reviewCommands = commandCatalog(
  allowInterference,
  removeInterferenceIntent,
  setPartGrounded,
  saveViewpoint,
  listViewpoints,
  deleteViewpoint,
  createWalkthrough,
  deleteWalkthrough,
  createReviewIssue,
);
