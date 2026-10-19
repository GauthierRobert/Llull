/** The PHY-05 nonlinear static commands (plugin `cae`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { setNonlinearControls } from './controlsCommand';
import { addCurveProbe } from './probeCommand';
import { setPartConstitutiveSet } from './partSetCommand';
import { addAnalysisStep } from './stepCommand';

export const nonlinearCommands = commandCatalog(setNonlinearControls, addAnalysisStep, addCurveProbe, setPartConstitutiveSet);
