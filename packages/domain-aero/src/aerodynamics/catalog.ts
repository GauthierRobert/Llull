/** Aerodynamics commands (10 AER), toolset `aerodynamics`. */

import { commandCatalog } from '@core/commands/schema';
import { standardAtmosphere } from './atmosphereCommand';
import { analyzeAirfoil, drawNacaAirfoil } from './airfoilCommands';
import { analyzeWing } from './wingCommand';
import { aeroDrag, frontalArea } from './dragCommands';
import { cyclingPower } from './cyclingCommand';

export const aerodynamicsCommands = commandCatalog(
  standardAtmosphere,
  drawNacaAirfoil,
  analyzeAirfoil,
  analyzeWing,
  frontalArea,
  aeroDrag,
  cyclingPower,
);
