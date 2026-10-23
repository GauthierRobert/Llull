/** Plant equipment plugin (plant 03 EQP), toolset `plant_equipment`: M1 head library + volumes, M2 vessels, columns, nozzles, ports, parameter revision. */

import type { CadPlugin } from '@core/plugins/plugin';
import { equipmentCatalog } from './catalog';

export const plantEquipmentPlugin: CadPlugin = { name: 'plant-equipment', toolset: 'plant_equipment', commands: equipmentCatalog };
