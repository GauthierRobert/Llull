/** Aerodynamic surfaces (02 SRF): airfoil sections and wings on exact NURBS geometry. */

import { commandCatalog } from '@core/commands/schema';
import { airfoilFromNaca, airfoilProperties, importAirfoil } from './airfoilCommands';
import { createWing, wingProperties } from './wingCommands';

export const surfacingCommands = commandCatalog(airfoilFromNaca, importAirfoil, airfoilProperties, createWing, wingProperties);
