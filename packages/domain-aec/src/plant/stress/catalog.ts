/** Pipe stress commands (07 PST): the `pipeStressPlugin` catalog. M1 quick checks, M3 model, analysis, record and approval, M4 report. */

import { commandCatalog } from '@core/commands/schema';
import { deleteSifOverride, setSifOverride } from './commands/sifOverrides';
import { deleteStressComponent, setStressComponent } from './commands/components';
import { analyzePipeStress, checkPipeStress } from './commands/analyze';
import { setPipeOperatingConditions, setStressLoadCases } from './commands/conditions';
import { guidedCantilever } from './commands/guidedCantilever';
import { createStressModel, deleteStressModel, updateStressModel } from './commands/modelCommands';
import { pipeSif } from './commands/pipeSif';
import { pipeStressReport } from './commands/pipeStressReport';
import { pipeStressAllowables } from './commands/pipeStressAllowables';
import { approvePipeStress, recordPipeStressResults } from './commands/record';
import { addStressRestraint, deleteStressRestraint } from './commands/restraints';
import { nozzleLoadCheck } from './commands/nozzleLoadCheck';
import { deleteSpringHanger, importSpringTable, selectSpringHangers } from './commands/springs';
import { springVariability } from './commands/springVariability';
import { thermalGrowth } from './commands/thermalGrowth';

export const pipeStressCommands = commandCatalog(
  pipeSif,
  pipeStressAllowables,
  thermalGrowth,
  guidedCantilever,
  springVariability,
  nozzleLoadCheck,
  importSpringTable,
  selectSpringHangers,
  deleteSpringHanger,
  createStressModel,
  updateStressModel,
  deleteStressModel,
  setPipeOperatingConditions,
  setStressLoadCases,
  addStressRestraint,
  deleteStressRestraint,
  setStressComponent,
  deleteStressComponent,
  setSifOverride,
  deleteSifOverride,
  analyzePipeStress,
  checkPipeStress,
  recordPipeStressResults,
  approvePipeStress,
  pipeStressReport,
);
