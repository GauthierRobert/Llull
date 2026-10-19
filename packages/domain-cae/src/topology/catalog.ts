/** PHY-17 topology optimisation: study set-up, validated result recording and the read-only queries (plugin `topology`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { checkTopology } from './checkQuery';
import { recordTopologyResult } from './record';
import { compareToTopology, suggestRebuild } from './rebuildQueries';
import { topologyReport } from './reportQuery';
import { createTopologyStudy, deleteTopologyStudy, setTopologyRegions, setTopologySettings } from './studyCommands';

export const topologyCommands = commandCatalog(
  createTopologyStudy,
  setTopologyRegions,
  setTopologySettings,
  deleteTopologyStudy,
  recordTopologyResult,
  topologyReport,
  suggestRebuild,
  compareToTopology,
  checkTopology,
);
