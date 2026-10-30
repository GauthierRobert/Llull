/** Commands of the implicit plugin (toolset `implicit`). */

import { commandCatalog } from '@core/commands/schema';
import type { CommandDefinition } from '@core/commands/types';
import { withArtifacts } from './sampledInputs';
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

const bareCommands = commandCatalog(
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

/** Every command runs with the artifact store of its context available to the field compiler (`sampledInputs.ts`). */
export const implicitCommands = bareCommands.map(
  (command): CommandDefinition<unknown> => ({
    ...command,
    run: (doc, params, ctx) => withArtifacts(ctx?.feaArtifacts, () => command.run(doc, params, ctx)),
  }),
);
