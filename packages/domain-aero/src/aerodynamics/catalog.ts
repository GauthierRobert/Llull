/** Aerodynamics commands (10 AER), toolset `aerodynamics`. */

import { commandCatalog } from '@core/commands/schema';
import { standardAtmosphere } from './atmosphereCommand';
import { analyzeAirfoil, drawNacaAirfoil } from './airfoilCommands';
import { analyzeWing } from './wingCommand';
import { frontalArea } from './frontalAreaCommand';
import { aeroDrag } from './aeroDragCommand';
import { roadLoadPowerCommand } from './roadLoadCommand';

export const aerodynamicsCommands = commandCatalog(
  standardAtmosphere,
  drawNacaAirfoil,
  analyzeAirfoil,
  analyzeWing,
  frontalArea,
  aeroDrag,
  roadLoadPowerCommand,
);
