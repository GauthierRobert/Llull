/** The 05 FEA set-up commands (lane 1). */

import { commandCatalog } from '@core/commands/schema';
import { createAnalysis, deleteAnalysis, describeAnalysis } from './analysis';
import { addFeaConstraint, deleteFeaConstraint, updateFeaConstraint } from './constraints';
import { addFeaLoad, deleteFeaLoad, updateFeaLoad } from './loads';
import { setMeshControls } from './mesh';
import { setPartIdealization } from './parts';
import { addResultProbe, deleteResultProbe } from './probes';

export const feaCommands = commandCatalog(
  createAnalysis,
  deleteAnalysis,
  describeAnalysis,
  setPartIdealization,
  addFeaConstraint,
  updateFeaConstraint,
  deleteFeaConstraint,
  addFeaLoad,
  updateFeaLoad,
  deleteFeaLoad,
  setMeshControls,
  addResultProbe,
  deleteResultProbe,
);
