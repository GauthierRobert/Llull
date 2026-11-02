/**
 * Piping catalogue plugin (plant 01 PSC, M0 to M4): the bundled open catalogue `llull-open-piping`, catalogue import / export / check, lookup,
 * pipe section properties, P-T ratings, and the pipe specs (import / create / edit / list / export, component and branch resolution, check, human-gated approval, assignment to pipe elements, B31.3 wall check, joints with stud lengths, component shapes, spec revision diff);
 * imported catalogues live in `doc.plant.catalog`, specs in `doc.plant.spec`. Toolset `piping`.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { commandCatalog } from '@core/commands/schema';
import { checkPipingCatalog } from './commands/check';
import { pipeSectionProperties, ptRating } from './commands/engineering';
import { pipeWallCheck } from './commands/wall';
import { exportPipingCatalog, importPipingCatalog } from './commands/importExport';
import { listPipingCatalogs, lookupPipingComponent } from './commands/queries';
import { approvePipeSpec } from '../spec/commands/approve';
import { assignPipeSpec } from '../spec/commands/assign';
import { checkPipeSpec } from '../spec/commands/check';
import { createPipeSpec, editPipeSpec, importPipeSpec } from '../spec/commands/author';
import { diffPipeSpec } from '../spec/commands/diff';
import { resolveJointCommand } from '../spec/commands/joint';
import { componentShape } from '../spec/commands/shape';
import { exportPipeSpec } from '../spec/commands/export';
import { listPipeSpecs, resolveBranchCommand, resolveSpecComponent } from '../spec/commands/queries';
import { pipingCatalogDocument } from './document';

export const pipingCatalogPlugin: CadPlugin = {
  name: 'piping-catalog',
  toolset: 'piping',
  commands: commandCatalog(
    listPipingCatalogs,
    lookupPipingComponent,
    importPipingCatalog,
    exportPipingCatalog,
    checkPipingCatalog,
    pipeSectionProperties,
    ptRating,
    importPipeSpec,
    createPipeSpec,
    editPipeSpec,
    listPipeSpecs,
    exportPipeSpec,
    resolveSpecComponent,
    resolveBranchCommand,
    checkPipeSpec,
    approvePipeSpec,
    assignPipeSpec,
    pipeWallCheck,
    resolveJointCommand,
    componentShape,
    diffPipeSpec,
  ),
  document: pipingCatalogDocument,
};
