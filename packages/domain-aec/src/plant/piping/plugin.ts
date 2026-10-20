/**
 * Plant piping plugin (plant 02 RTE): tie-in ports, pipe lines and runs in `doc.plant.piping`, the auto-router (`route_problem`,
 * `auto_route_pipe`; native search through the `auto_route` transport in server/), toolset `piping`.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { commandCatalog } from '@core/commands/schema';
import { addTieInPoint } from './commands/tieIn';
import { createPipeline } from './commands/pipeline';
import { autoRoutePipe, routeProblem } from './commands/autoRoute';
import { deletePipeRun } from './commands/deleteRun';
import { pipingDerivationGuard, pipingDocument } from './derive';

export const pipingPlugin: CadPlugin = {
  name: 'piping',
  toolset: 'piping',
  commands: commandCatalog(addTieInPoint, createPipeline, routeProblem, autoRoutePipe, deletePipeRun),
  guards: [pipingDerivationGuard],
  document: pipingDocument,
};
