/** Components, instances, mates and the bill of materials. */

import { commandCatalog } from '../schema';
import { createComponent, insertInstance, explodeInstance } from './assemblies';
import { addMate } from './mates';
import { billOfMaterials } from './billOfMaterials';

export const assemblyCommands = commandCatalog(
  createComponent,
  insertInstance,
  explodeInstance,
  addMate,
  billOfMaterials,
);
