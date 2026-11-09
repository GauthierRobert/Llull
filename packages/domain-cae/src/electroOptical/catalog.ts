/** The PHY-15 electro-optical commands (plugin `physics-electro-optical`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { defineBondPath, deleteBondPath } from './bondCommands';
import { checkBonding } from './checkBonding';
import { assignSurfaceCoating, removeSurfaceCoating } from './coatingCommands';
import { checkSurfaceProperties } from './checkSurfaceProperties';
import { electricalResistance, shieldAbsorption } from './conductorQueries';
import { disposeBondCheck } from './disposeCommand';
import { normalReflectance } from './normalReflectance';
import { opticalBalance } from './opticalBalance';

export const electroOpticalCommands = commandCatalog(
  assignSurfaceCoating,
  removeSurfaceCoating,
  defineBondPath,
  deleteBondPath,
  checkBonding,
  opticalBalance,
  disposeBondCheck,
  checkSurfaceProperties,
  electricalResistance,
  shieldAbsorption,
  normalReflectance,
);
