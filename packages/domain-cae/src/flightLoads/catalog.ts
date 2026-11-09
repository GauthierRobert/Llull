/** 14 FLL flight-loads commands. */

import { commandCatalog } from '@core/commands/schema';
import { exportFlightLoads } from './exportFlightLoads';
import { setFreeBodySupport } from './freeBodySupport';

export const flightLoadCommands = commandCatalog(exportFlightLoads, setFreeBodySupport);
