/** Pipe stress commands (07 PST): the `pipeStressPlugin` catalog. M1 quick checks, M3 model, analysis, record and approval. */

import { commandCatalog } from '@core/commands/schema';
import { analyzePipeStress, checkPipeStress } from './commands/analyze';
import { setPipeOperatingConditions, setStressLoadCases } from './commands/conditions';
import { guidedCantilever } from './commands/guidedCantilever';
import { createStressModel, deleteStressModel, updateStressModel } from './commands/modelCommands';
import { pipeSif } from './commands/pipeSif';
import { pipeStressAllowables } from './commands/pipeStressAllowables';
import { approvePipeStress, recordPipeStressResults } from './commands/record';
import { addStressRestraint, deleteStressRestraint } from './commands/restraints';
import { thermalGrowth } from './commands/thermalGrowth';

export const pipeStressCommands = commandCatalog(
  pipeSif,
  pipeStressAllowables,
  thermalGrowth,
  guidedCantilever,
  createStressModel,
  updateStressModel,
  deleteStressModel,
  setPipeOperatingConditions,
  setStressLoadCases,
  addStressRestraint,
  deleteStressRestraint,
  analyzePipeStress,
  checkPipeStress,
  recordPipeStressResults,
  approvePipeStress,
);
