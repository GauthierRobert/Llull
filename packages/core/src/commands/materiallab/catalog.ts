/** Material lab (PHY-02): fit constitutive laws, drive a material point, export solver material cards — read-only queries. */

import { commandCatalog } from '../schema';
import { fitMaterialModel } from './fitMaterialModel';
import { materialPointResponse } from './materialPointResponse';
import { exportMaterialCards } from './exportMaterialCards';

export const materialLabCommands = commandCatalog(fitMaterialModel, materialPointResponse, exportMaterialCards);
