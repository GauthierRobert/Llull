/** Registered commands of the plant equipment plugin (plant 03 EQP). */

import { commandCatalog } from '@core/commands/schema';
import { addProcessColumn } from './commands/addProcessColumn';
import { addVessel } from './commands/addVessel';
import { equipmentPortsQuery } from './commands/equipmentPortsQuery';
import { addNozzle, deleteNozzle, updateNozzle } from './commands/nozzles';
import { updateEquipmentParameters } from './commands/updateEquipmentParameters';
import { renameEquipmentTag } from './commands/renameEquipmentTag';
import { vesselVolume } from './commands/vesselVolume';

export const equipmentCatalog = commandCatalog(
  addVessel,
  addProcessColumn,
  addNozzle,
  updateNozzle,
  deleteNozzle,
  equipmentPortsQuery,
  updateEquipmentParameters,
  renameEquipmentTag,
  vesselVolume,
);
