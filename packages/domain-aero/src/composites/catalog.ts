/** Composite structures (06 CMP): lamina materials, rosettes, parts, zones, plies, laminate analysis, layup checks, flat patterns. */

import { commandCatalog } from '@core/commands/schema';
import { analyzeLaminate } from './analyzeCommand';
import { exportFlatPatternsDxf } from './flatPatternDxf';
import { generatePliesFromZones } from './generateCommand';
import { checkLayup, requestLayupWaiver } from './layupCommands';
import { createLaminaMaterial, defineRosette } from './materialCommands';
import { laminateMass } from './massCommand';
import { createCompositePart, setLaminateRules, setPlyDropRules } from './partCommands';
import { addPly, deletePly, editPly, reorderPlies } from './plyCommands';
import { exportPlyTable, importPlyTable, plyBookData } from './plyTable';
import { createLaminateSections, exportLaminateSections } from './sectionCommands';
import { checkLaminateRules } from './rulesCommand';
import { coreSample } from './sampleCommand';
import { defineZone, deleteZone, editZone } from './zoneCommands';

export const compositesCommands = commandCatalog(
  createLaminaMaterial,
  defineRosette,
  createCompositePart,
  defineZone,
  editZone,
  deleteZone,
  setPlyDropRules,
  setLaminateRules,
  generatePliesFromZones,
  addPly,
  editPly,
  deletePly,
  reorderPlies,
  coreSample,
  checkLaminateRules,
  analyzeLaminate,
  laminateMass,
  checkLayup,
  requestLayupWaiver,
  exportFlatPatternsDxf,
  createLaminateSections,
  exportLaminateSections,
  exportPlyTable,
  importPlyTable,
  plyBookData,
);
