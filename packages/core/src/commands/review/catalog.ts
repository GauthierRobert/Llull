/** Prototype review: declared interference intents and grounded parts (the checks themselves are in inspect/). */

import { commandCatalog } from '../schema';
import { setPartGrounded } from './grounding';
import { allowInterference, removeInterferenceIntent } from './intents';

export const reviewCommands = commandCatalog(allowInterference, removeInterferenceIntent, setPartGrounded);
