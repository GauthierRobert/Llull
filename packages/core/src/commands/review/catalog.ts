/** Prototype review: declared interference intents, grounded parts and reviewer dispositions (the checks themselves are in inspect/ and dynamics/). */

import { commandCatalog } from '../schema';
import { setReviewDisposition } from './dispositions';
import { setPartGrounded } from './grounding';
import { allowInterference, removeInterferenceIntent } from './intents';

export const reviewCommands = commandCatalog(allowInterference, removeInterferenceIntent, setPartGrounded, setReviewDisposition);
