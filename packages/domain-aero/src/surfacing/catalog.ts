/** Aerodynamic surfaces (02 SRF): airfoil sections and wings on exact NURBS geometry. */

import { commandCatalog } from '@core/commands/schema';
import { setAircraftFrame } from './aircraftFrame';
import { fuselageSectionAt } from './fuselageSectionAt';
import { airfoilFromNaca, airfoilProperties, importAirfoil } from './airfoilCommands';
import { loftFuselage } from './fuselageCommand';
import { createWing, wingProperties } from './wingCommands';

export const surfacingCommands = commandCatalog(
  airfoilFromNaca,
  importAirfoil,
  airfoilProperties,
  createWing,
  wingProperties,
  loftFuselage,
  setAircraftFrame,
  fuselageSectionAt,
);
