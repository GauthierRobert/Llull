/** The PHY-16 PRC additive-build commands (plugin `cae`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { addReleaseStep } from './releaseCommand';
import { amBuildSetup } from './setup';
import { setInherentStrain } from './strainCommand';

export const processCommands = commandCatalog(amBuildSetup, setInherentStrain, addReleaseStep);
