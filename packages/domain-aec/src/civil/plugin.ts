/**
 * Civil / site-engineering plugin: survey, terrain, earthworks, roads and drainage commands, the
 * `civil` MCP toolset, the derivation guard and the document extension that validates the civil
 * model and re-derives its geometry on load.
 * @layer domain-aec/civil
 */

import { commandCatalog } from '@core/commands/schema';
import type { CadPlugin } from '@core/plugins/plugin';
import { civilDerivationGuard } from './integrity';
import { derivedModelExtension } from '../shared/derived';
import { civilErrors } from './validate';
import { regenerateCivil } from './evaluate';
import { createSurface, importSurveyPoints, updateSurface } from './survey/surveyCommands';
import { surfaceElevation, surfaceReport } from './surface/surfaceQueries';
import { importSurveyDxf } from './survey/surveyDxf';
import { deleteCivilObject, describeCivil } from './civilCommands';
import { earthworksCommands } from './earthworks/earthworksCommands';
import { roadCommands } from './road/roadCommands';
import { drainageCommands } from './drainage/drainageCommands';
import { civilExchangeCommands } from './exchange/exchangeCommands';
import { crsCommands } from './crs/crsCommands';
import { civilSheetCommands } from './sheets/civilSheetCommands';

const civilDocument = derivedModelExtension({
  key: 'civil',
  owners: (civil) => Object.values(civil.objects),
  errors: civilErrors,
  seed: (civil) => ({ ...civil, objects: {} }),
  regenerate: regenerateCivil,
});

/** Civil / site-engineering commands. */
export const civilCommands = commandCatalog(
  importSurveyPoints,
  importSurveyDxf,
  createSurface,
  updateSurface,
  surfaceElevation,
  surfaceReport,
  describeCivil,
  deleteCivilObject,
  ...earthworksCommands,
  ...roadCommands,
  ...drainageCommands,
  ...civilExchangeCommands,
  ...crsCommands,
  ...civilSheetCommands,
);

export const civilPlugin: CadPlugin = {
  name: 'civil',
  toolset: 'civil',
  commands: civilCommands,
  guards: [civilDerivationGuard],
  document: civilDocument,
};
