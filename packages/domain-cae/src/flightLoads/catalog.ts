/** 14 FLL flight-loads commands. */

import { commandCatalog } from '@core/commands/schema';
import { checkRotorResonance } from './checkRotorResonance';
import { exportFlightLoads } from './exportFlightLoads';
import { setFreeBodySupport } from './freeBodySupport';
import { printCommands } from './print/catalog';

export const flightLoadCommands = [...commandCatalog(checkRotorResonance, exportFlightLoads, setFreeBodySupport), ...printCommands];
