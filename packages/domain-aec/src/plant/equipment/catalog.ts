/** Registered commands of the plant equipment plugin (plant 03 EQP). */

import { commandCatalog } from '@core/commands/schema';
import { vesselVolume } from './commands/vesselVolume';

export const equipmentCatalog = commandCatalog(vesselVolume);
