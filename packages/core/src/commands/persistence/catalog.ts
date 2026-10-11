/** Whole-document load. */

import { commandCatalog } from '../schema';
import { loadDocument } from './serialization';

export const persistenceCommands = commandCatalog(loadDocument);
