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
import { addCornerRelief } from './commands/cornerRelief';
import { addFlangedHole } from './commands/flangedHole';
import { addBead } from './commands/bead';
import { addHem } from './commands/hem';
import { checkSheetMetal } from './commands/check';
import { exportFlatPatternDxf } from './commands/dxf';
import { convertToSheetMetal } from './commands/convert';
import { setSheetMetalMaterial } from './commands/material';

// prettier-ignore
export const sheetMetalCommands = commandCatalog(
  sheetMetalCalc, createSheetMetalRule, importBendRadiusTable, addSheetMetalBase, addFlange, addJoggle, addSheetCutout, addRelief, addCornerRelief, addFlangedHole, addBead, addHem, flatPattern,
  materializeFlatPattern, checkSheetMetal, exportFlatPatternDxf,
  convertToSheetMetal, setSheetMetalMaterial,
);
