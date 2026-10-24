/**
 * Plant piping plugin (plant 02 RTE): tie-in ports, pipe lines and runs in `doc.plant.piping`, spec-driven `route_pipe` / `piping_takeoff` (derived
 * parts, joints and display entities), valves / reducers / branches, `check_piping`, `piping_connectivity`, the auto-router (`route_problem`,
 * `auto_route_pipe`; native search through the `auto_route` transport in server/), toolset `piping`.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { commandCatalog } from '@core/commands/schema';
import { addTieInPoint } from './commands/tieIn';
import { createPipeline } from './commands/pipeline';
import { autoRoutePipe, routeProblem } from './commands/autoRoute';
import { convertPipeRun } from './commands/convertPipeRun';
import { deletePipeRun } from './commands/deleteRun';
import { routePipe } from './commands/routePipe';
import { addBranch } from './commands/addBranch';
import { checkPiping } from './commands/checkPiping';
import { insertInlineComponent, moveInlineComponent, removeInlineComponent } from './commands/inlineComponents';
import { pipingConnectivity } from './commands/pipingConnectivity';
import { pipingTakeoff } from './commands/pipingTakeoff';
import { updatePipeline } from './commands/updatePipeline';
import { pipingDerivationGuard, pipingDocument } from './derive';

export const pipingPlugin: CadPlugin = {
  name: 'piping',
  toolset: 'piping',
  commands: commandCatalog(
    addTieInPoint,
    createPipeline,
    updatePipeline,
    routePipe,
    insertInlineComponent,
    moveInlineComponent,
    removeInlineComponent,
    addBranch,
    convertPipeRun,
    pipingTakeoff,
    pipingConnectivity,
    checkPiping,
    routeProblem,
    autoRoutePipe,
    deletePipeRun,
  ),
  guards: [pipingDerivationGuard],
  document: pipingDocument,
};
