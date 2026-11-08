/** The PHY-11 creep commands (plugin `cae`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { creepClosedForm } from './closedFormCommand';
import { checkCreep, creepReport } from './queries';
import { deleteCreepStep, setCreepStep } from './stepCommands';

export const creepCommands = commandCatalog(creepClosedForm, setCreepStep, deleteCreepStep, creepReport, checkCreep);
