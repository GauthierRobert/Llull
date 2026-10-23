/** Plant equipment plugin (plant 03 EQP): parametric vessel geometry queries; toolset `plant_equipment`. M1 = head library + volumes (`vessel_volume`). */

import type { CadPlugin } from '@core/plugins/plugin';
import { equipmentCatalog } from './catalog';

export const plantEquipmentPlugin: CadPlugin = { name: 'plant-equipment', toolset: 'plant_equipment', commands: equipmentCatalog };
