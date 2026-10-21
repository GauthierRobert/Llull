/** The 05 FEA set-up commands (lane 1). */

import { commandCatalog } from '@core/commands/schema';
import { checkAnalysis } from './check';
import { analysisReport } from './analysisReport';
import { deleteAnalysisItem } from './deleteItem';
import { createAnalysis, deleteAnalysis, describeAnalysis } from './analysis';
import { addFeaConstraint, updateFeaConstraint } from './constraints';
import { addFeaLoad, updateFeaLoad } from './loads';
import { setMeshControls } from './mesh';
import { setPartIdealization } from './parts';
import { defeatureForAnalysis, extractMidsurface } from './shellCommands';
import { addResultProbe } from './probes';
import { probeHistory } from './probeHistory';
import { recordFeMesh, recordFeaResults } from './record';
import { setMarginBand } from '../margins/marginBandCommand';
import { setBucklingPreload } from './bucklingPreload';
import { feaResultField } from './resultField';
import { setResultView } from './resultView';
import { renderFeaResults } from './renderResults';

export const feaCommands = commandCatalog(
  createAnalysis,
  deleteAnalysisItem,
  deleteAnalysis,
  describeAnalysis,
  analysisReport,
  setPartIdealization,
  extractMidsurface,
  defeatureForAnalysis,
  addFeaConstraint,
  updateFeaConstraint,
  addFeaLoad,
  updateFeaLoad,
  setMeshControls,
  addResultProbe,
  probeHistory,
  recordFeMesh,
  recordFeaResults,
  renderFeaResults,
  checkAnalysis,
  setMarginBand,
  setBucklingPreload,
  feaResultField,
  setResultView,
);
