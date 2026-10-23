/**
 * Piping catalogue plugin (plant 01 PSC, M0 + M1): the bundled open catalogue `llull-open-piping`, catalogue import / export / check, lookup,
 * pipe section properties and P-T ratings; imported catalogues live in `doc.plant.catalog`. Toolset `piping`. Specs (M2) and the
 * `add_pipe_run` / `assign_pipe_spec` integration (M3) extend this plugin.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { commandCatalog } from '@core/commands/schema';
import { checkPipingCatalog } from './commands/check';
import { pipeSectionProperties, ptRating } from './commands/engineering';
import { exportPipingCatalog, importPipingCatalog } from './commands/importExport';
import { listPipingCatalogs, lookupPipingComponent } from './commands/queries';
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
  ),
  document: pipingCatalogDocument,
};
