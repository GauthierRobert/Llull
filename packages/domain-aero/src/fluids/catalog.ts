/** Fluid-dynamics and propulsion commands (11 FLD), toolset `fluids`. */

import { commandCatalog } from '@core/commands/schema';
import { compressibleFlow } from './compressibleCommand';
import { nozzlePerformance } from './nozzleCommand';
import { designNozzle } from './designNozzleCommand';
import { rocketDeltaV } from './rocketEquationCommand';

export const fluidsCommands = commandCatalog(compressibleFlow, nozzlePerformance, designNozzle, rocketDeltaV);
