/** Commands of the implicit plugin (toolset `implicit`). */

import { commandCatalog } from '@core/commands/schema';
import { createImplicitBody } from './bodyCommand';
import { checkImplicit } from './checkImplicit';
import { editField } from './editCommand';
import { evaluateField } from './evaluateCommand';
import { addGraphLattice } from './graphCommand';
import { addVoronoiLattice } from './voronoiCommand';
import { infillSolid } from './infillCommand';
import { addStrutLattice, addTpmsLattice } from './latticeCommands';
import { latticeProperties } from './latticeProperties';
import { deleteField, regenerateImplicitBodies } from './lifecycleCommands';
import { combineFields, offsetField, shellField, transformField } from './opCommands';
import { addFieldPrimitive } from './primitiveCommand';
import { implicitProperties } from './propertiesQuery';
import { createScalarField } from './scalarCommand';
import { sectionField } from './sectionCommand';
import { fieldFromSolid } from './solidCommand';

export const implicitCommands = commandCatalog(
  addFieldPrimitive,
  fieldFromSolid,
  combineFields,
  offsetField,
  shellField,
  transformField,
  createScalarField,
  addTpmsLattice,
  addStrutLattice,
  addGraphLattice,
  addVoronoiLattice,
  editField,
  deleteField,
  createImplicitBody,
  infillSolid,
  regenerateImplicitBodies,
  evaluateField,
  implicitProperties,
  latticeProperties,
  sectionField,
  checkImplicit,
);
