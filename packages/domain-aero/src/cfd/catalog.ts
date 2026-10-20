/** Flow (CFD) commands (12 CFD M1), toolset `flow`. */

import { commandCatalog } from '@core/commands/schema';
import { cfdCreateCase, cfdDeleteCase, cfdSetBoundary, cfdUpdateCase } from './caseCommands';
import { checkCfd } from './checkCommand';
import { cfdPrepare } from './prepareCommand';

export const cfdCommands = commandCatalog(cfdCreateCase, cfdUpdateCase, cfdDeleteCase, cfdSetBoundary, cfdPrepare, checkCfd);
