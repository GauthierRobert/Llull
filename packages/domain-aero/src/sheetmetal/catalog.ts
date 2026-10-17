/** Sheet-metal commands (07 FTR §4.2), toolset `manufacturing`. */

import { commandCatalog } from '@core/commands/schema';
import { sheetMetalCalc } from './commands/calc';
import { createSheetMetalRule, importBendRadiusTable } from './commands/rules';
import { addSheetMetalBase } from './commands/base';
import { addFlange } from './commands/flange';
import { flatPattern, materializeFlatPattern } from './commands/flatPattern';
import { addJoggle } from './commands/joggle';
import { addSheetCutout } from './commands/cutout';
import { addRelief } from './commands/relief';
import { checkSheetMetal } from './commands/check';
import { exportFlatPatternDxf } from './commands/dxf';

// prettier-ignore
export const sheetMetalCommands = commandCatalog(
  sheetMetalCalc, createSheetMetalRule, importBendRadiusTable, addSheetMetalBase, addFlange, addJoggle, addSheetCutout, addRelief, flatPattern,
  materializeFlatPattern, checkSheetMetal, exportFlatPatternDxf,
);
