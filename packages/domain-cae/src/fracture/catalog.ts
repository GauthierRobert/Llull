/** PHY-08 fracture mechanics and damage-tolerance commands. */

import { commandCatalog } from '@core/commands/schema';
import { defineCrack, deleteCrack, updateCrack } from './crackCommands';
import { checkDamageTolerance, computeCrackGrowth, computeInspectionInterval, computeResidualStrength } from './damageTolerance';
import { createCrackGrowthCase, deleteCrackGrowthCase, setDamageToleranceFactors } from './growthCaseCommands';
import { crackGrowthRate, stressIntensity } from './kQueries';

export const fractureCommands = commandCatalog(
  defineCrack,
  updateCrack,
  deleteCrack,
  createCrackGrowthCase,
  deleteCrackGrowthCase,
  setDamageToleranceFactors,
  stressIntensity,
  crackGrowthRate,
  computeCrackGrowth,
  computeResidualStrength,
  computeInspectionInterval,
  checkDamageTolerance,
);
