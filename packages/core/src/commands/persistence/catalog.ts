/** Whole-document load and the release-scope content hash. */

import { commandCatalog } from '../schema';
import { loadDocument } from './serialization';
import { documentContentHash } from './releaseScope';

export const persistenceCommands = commandCatalog(loadDocument, documentContentHash);
