/** Components, instances and the bill of materials. */

import { commandCatalog } from '../schema';
import { createComponent, insertInstance, explodeInstance } from './assemblies';
import { billOfMaterials } from './billOfMaterials';
import { createExplodedView, deleteExplodedView, setActiveExplodedView } from './explodedViews';

export const assemblyCommands = commandCatalog(
  createComponent,
  insertInstance,
  explodeInstance,
  billOfMaterials,
  createExplodedView,
  setActiveExplodedView,
  deleteExplodedView,
);
