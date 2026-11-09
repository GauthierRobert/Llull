/** The PHY-05 nonlinear static commands (plugin `cae`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { beamLargeDeflection } from './beam/beamCommand';
import { setNonlinearControls } from './controlsCommand';
import { addImperfection, deleteImperfection } from './imperfectionCommand';
import { limitLoad } from './limitLoadCommand';
import { nonlinearAnalyticCheck } from './analyticCommand';
import { checkNonlinear } from './checkCommand';
import { addCurveProbe, deleteCurveProbe } from './probeCommand';
import { nonlinearReport } from './reportCommand';
import { setPartConstitutiveSet } from './partSetCommand';
import { addAnalysisStep } from './stepCommand';
import { deleteAnalysisStep, updateAnalysisStep } from './stepEditCommand';

export const nonlinearCommands = commandCatalog(
  setNonlinearControls,
  addAnalysisStep,
  updateAnalysisStep,
  deleteAnalysisStep,
  addCurveProbe,
  deleteCurveProbe,
  setPartConstitutiveSet,
  addImperfection,
  deleteImperfection,
  beamLargeDeflection,
  limitLoad,
  nonlinearReport,
  checkNonlinear,
  nonlinearAnalyticCheck,
);
