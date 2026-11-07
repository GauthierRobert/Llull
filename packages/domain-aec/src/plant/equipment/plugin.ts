/** Plant equipment plugin (plant 03 EQP), toolset `plant_equipment`: M1 head library + volumes, M2 vessels, columns, nozzles, ports, parameter revision; the bundle-pull keep-clear zone of `check_clashes`. */

import type { CadPlugin } from '@core/plugins/plugin';
import { registerClashSource } from '../../industrial/clash/clashSources';
import { equipmentCatalog } from './catalog';
import { bundlePullBodies } from './clash/bundlePullBodies';

export const plantEquipmentPlugin: CadPlugin = {
  name: 'plant-equipment',
  toolset: 'plant_equipment',
  commands: equipmentCatalog,
  onInstall: () => registerClashSource(bundlePullBodies),
};
