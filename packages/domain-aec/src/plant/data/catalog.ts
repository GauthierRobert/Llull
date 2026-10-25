import { commandCatalog } from '@core/commands/schema';
import { assignPlantObject } from './commands/assignPlantObject';
import { checkPlantData } from './commands/checkPlantData';
import { definePlantClass } from './commands/defineClass';
import { definePlantHierarchy } from './commands/defineHierarchy';
import { loadPlantClassLibrary } from './commands/loadPlantClassLibrary';
import { plantDataTable } from './commands/plantDataTable';
import { setPlantProperties } from './commands/setPlantProperties';
import { setTagFormat } from './commands/setTagFormat';
import { unassignPlantObject } from './commands/unassignPlantObject';

export const plantDataCatalog = commandCatalog(
  definePlantHierarchy,
  definePlantClass,
  loadPlantClassLibrary,
  setTagFormat,
  assignPlantObject,
  setPlantProperties,
  unassignPlantObject,
  plantDataTable,
  checkPlantData,
);
