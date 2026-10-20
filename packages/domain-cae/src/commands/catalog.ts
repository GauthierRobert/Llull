/** The 05 FEA set-up commands (lane 1). */

import { commandCatalog } from '@core/commands/schema';
import { checkAnalysis } from './check';
import { createAnalysis, deleteAnalysis, describeAnalysis } from './analysis';
import { addFeaConstraint, deleteFeaConstraint, updateFeaConstraint } from './constraints';
import { addFeaLoad, deleteFeaLoad, updateFeaLoad } from './loads';
import { setMeshControls } from './mesh';
import { setPartIdealization } from './parts';
import { defeatureForAnalysis, extractMidsurface } from './shellCommands';
import { addResultProbe, deleteResultProbe } from './probes';
import { probeHistory } from './probeHistory';
import { recordFeMesh, recordFeaResults } from './record';
import { setMarginBand } from '../margins/marginBandCommand';
import { setBucklingPreload } from './bucklingPreload';
import { feaResultField } from './resultField';
import { setResultView } from './resultView';
import { feaReport } from './report';
import { renderFeaResults } from './renderResults';

export const feaCommands = commandCatalog(
  createAnalysis,
  deleteAnalysis,
  describeAnalysis,
  setPartIdealization,
  extractMidsurface,
  defeatureForAnalysis,
  addFeaConstraint,
  updateFeaConstraint,
  deleteFeaConstraint,
  addFeaLoad,
  updateFeaLoad,
  deleteFeaLoad,
  setMeshControls,
  addResultProbe,
  deleteResultProbe,
  probeHistory,
  recordFeMesh,
  recordFeaResults,
  feaReport,
  renderFeaResults,
  checkAnalysis,
  setMarginBand,
  setBucklingPreload,
  feaResultField,
  setResultView,
);
