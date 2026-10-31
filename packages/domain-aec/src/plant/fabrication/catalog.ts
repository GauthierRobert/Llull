import { commandCatalog } from '@core/commands/schema';
import { addFieldWeld } from './commands/addFieldWeld';
import { checkIsometric } from './commands/checkIsometric';
import { cutList } from './commands/cutListCommand';
import { defineIsometric } from './commands/defineIsometric';
import { deletePcfLine } from './commands/deletePcfLine';
import { exportPcf } from './commands/exportPcf';
import { exportIsometric } from './commands/exportIsometric';
import { importPcf } from './commands/importPcf';
import { issueIsometric } from './commands/issueIsometric';
import { numberWelds } from './commands/numberWelds';
import { pipingBom } from './commands/pipingBom';
import { setFabricationRules } from './commands/setFabricationRules';
import { setWeldType } from './commands/setWeldType';
import { splitSpools } from './commands/splitSpools';
import { spoolList } from './commands/spoolList';
import { weldList } from './commands/weldList';

export const fabricationCatalog = commandCatalog(
  importPcf,
  exportPcf,
  deletePcfLine,
  addFieldWeld,
  setWeldType,
  numberWelds,
  weldList,
  setFabricationRules,
  splitSpools,
  spoolList,
  cutList,
  pipingBom,
  exportIsometric,
  checkIsometric,
  defineIsometric,
  issueIsometric,
);
