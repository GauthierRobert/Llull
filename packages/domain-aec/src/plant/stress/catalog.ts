/** Pipe stress commands (07 PST): the `pipeStressPlugin` catalog. M1 holds the closed-form quick checks. */

import { commandCatalog } from '@core/commands/schema';
import { guidedCantilever } from './commands/guidedCantilever';
import { pipeSif } from './commands/pipeSif';
import { pipeStressAllowables } from './commands/pipeStressAllowables';
import { thermalGrowth } from './commands/thermalGrowth';

export const pipeStressCommands = commandCatalog(pipeSif, pipeStressAllowables, thermalGrowth, guidedCantilever);
