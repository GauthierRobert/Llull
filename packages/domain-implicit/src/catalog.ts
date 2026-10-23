/** Commands of the implicit plugin (toolset `implicit`). */

import { commandCatalog } from '@core/commands/schema';
import { createImplicitBody } from './bodyCommand';
import { checkImplicit } from './checkImplicit';
import { evaluateField } from './evaluateCommand';
import { addStrutLattice, addTpmsLattice } from './latticeCommands';
import { latticeProperties } from './latticeProperties';
import { combineFields, offsetField, shellField, transformField } from './opCommands';
import { addFieldPrimitive } from './primitiveCommand';
import { implicitProperties } from './propertiesQuery';
import { fieldFromSolid } from './solidCommand';

export const implicitCommands = commandCatalog(
  addFieldPrimitive,
  fieldFromSolid,
  combineFields,
  offsetField,
  shellField,
  transformField,
  addTpmsLattice,
  addStrutLattice,
  createImplicitBody,
  evaluateField,
  implicitProperties,
  latticeProperties,
  checkImplicit,
);
