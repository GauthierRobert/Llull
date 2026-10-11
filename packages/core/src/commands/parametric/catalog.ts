/** Parameters, configurations, recipes and constraints. */

import { commandCatalog } from '../schema';
import { setParameter, deleteParameter } from './parameters';
import { createConfiguration, activateConfiguration } from './configurations';
import { saveRecipe, instantiateRecipe } from './recipes';
import { addConstraint, deleteConstraint, updateConstraint, solveConstraints } from './constraints';

export const parametricCommands = commandCatalog(
  setParameter,
  deleteParameter,
  createConfiguration,
  activateConfiguration,
  saveRecipe,
  instantiateRecipe,
  addConstraint,
  deleteConstraint,
  updateConstraint,
  solveConstraints,
);
