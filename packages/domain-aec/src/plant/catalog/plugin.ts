/**
 * Piping catalogue plugin (plant 01 PSC, M0 to M2): the bundled open catalogue `llull-open-piping`, catalogue import / export / check, lookup,
 * pipe section properties, P-T ratings, and the pipe specs (import / create / edit / list / export, component and branch resolution, check);
 * imported catalogues live in `doc.plant.catalog`, specs in `doc.plant.spec`. Toolset `piping`. The `add_pipe_run` / `assign_pipe_spec`
 * integration and approval (M3) extend this plugin.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { commandCatalog } from '@core/commands/schema';
import { checkPipingCatalog } from './commands/check';
import { pipeSectionProperties, ptRating } from './commands/engineering';
import { exportPipingCatalog, importPipingCatalog } from './commands/importExport';
import { listPipingCatalogs, lookupPipingComponent } from './commands/queries';
import { checkPipeSpec } from '../spec/commands/check';
import { createPipeSpec, editPipeSpec, importPipeSpec } from '../spec/commands/author';
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
  ),
  document: pipingCatalogDocument,
};
