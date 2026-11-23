/** Flow (CFD) commands (12 CFD M1 + M2 records), toolset `flow`. */

import { commandCatalog } from '@core/commands/schema';
import { cfdCreateCase, cfdDeleteCase, cfdSetBoundary, cfdUpdateCase } from './caseCommands';
import { recordCfdGridStudy } from './gridStudyCommand';
import { checkCfd } from './checkCommand';
import { cfdPrepare } from './prepareCommand';
import { recordCfdResults } from './recordCommand';
import { cfdReport } from './reportCommand';

export const cfdCommands = commandCatalog(
  cfdCreateCase,
  cfdUpdateCase,
  cfdDeleteCase,
  cfdSetBoundary,
  cfdPrepare,
  checkCfd,
  recordCfdResults,
  cfdReport,
  recordCfdGridStudy,
);
