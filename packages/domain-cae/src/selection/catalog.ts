/** PHY-12 material-selection commands (read-only queries over the stored 08 / PHY-01 material values). */

import { commandCatalog } from '@core/commands/schema';
import { checkMaterialSelection } from './checkCommand';
import { compareMaterials } from './compareCommand';
import { materialIndex } from './materialIndexCommand';
import { substituteMaterial } from './substituteCommand';

export const selectionCommands = commandCatalog(materialIndex, compareMaterials, substituteMaterial, checkMaterialSelection);
