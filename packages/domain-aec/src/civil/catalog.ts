/**
 * Civil / site-engineering commands — survey, terrain, earthworks, roads, drainage — the `civil`
 * plugin's catalog (see plugin.ts).
 * @layer domain-aec/civil
 */

import { commandCatalog } from '@core/commands/schema';
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
