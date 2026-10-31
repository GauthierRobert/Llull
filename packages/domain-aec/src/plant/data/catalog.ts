import { commandCatalog } from '@core/commands/schema';
import { assignPlantObject } from './commands/assignPlantObject';
import { assignPlantObjects } from './commands/assignPlantObjects';
import { checkIfcRequirements } from './commands/checkIfcRequirements';
import { checkPlantData } from './commands/checkPlantData';
import { exportPlantData } from './commands/exportPlantData';
import { definePlantClass } from './commands/defineClass';
import { definePlantHierarchy } from './commands/defineHierarchy';
import { ifcSummary } from './commands/ifcSummary';
import { importPlantData } from './commands/importPlantData';
import { importTagList } from './commands/importTagList';
import { loadPlantClassLibrary } from './commands/loadPlantClassLibrary';
import { plantDataTable } from './commands/plantDataTable';
import { plantReport } from './commands/plantReport';
import { renumberTags } from './commands/renumberTags';
import { saveReportDefinition } from './commands/saveReportDefinition';
import { setPlantProperties } from './commands/setPlantProperties';
import { setTagFormat } from './commands/setTagFormat';
import { unassignPlantObject } from './commands/unassignPlantObject';

export const plantDataCatalog = commandCatalog(
  definePlantHierarchy,
  definePlantClass,
  loadPlantClassLibrary,
  setTagFormat,
  assignPlantObject,
  assignPlantObjects,
  setPlantProperties,
  unassignPlantObject,
  plantDataTable,
  checkPlantData,
  plantReport,
  exportPlantData,
  importPlantData,
  importTagList,
  renumberTags,
  saveReportDefinition,
  ifcSummary,
  checkIfcRequirements,
);
