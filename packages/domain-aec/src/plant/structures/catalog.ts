/** Plant structures and access commands (06 STA): the `structuresPlugin` catalog. */

import { commandCatalog } from '@core/commands/schema';
import { checkAccess } from './access/checkAccess';
import { accessGraph } from './access/graph/accessGraphCommand';
import { checkReachability } from './access/reach/checkReachability';
import { exportAccessPlan } from './symbols/exportAccessPlan';
import { listAccessRules } from './access/listAccessRules';
import { addGrating } from './grating/addGrating';
import { checkGrating } from './grating/checkGrating';
import { listGratingTypes } from './grating/listGratingTypes';
import { updateGrating } from './grating/updateGrating';
import { addLadder } from './ladder/addLadder';
import { addSteelStair } from './stair/addSteelStair';
import { addRailing } from './railing/addRailing';
import { updateRailing } from './railing/updateRailing';
import { accessPlatformTakeoff } from './platform/accessPlatformTakeoff';
import { addAccessPlatform } from './platform/addAccessPlatform';
import { addCircularAccessPlatform } from './platform/addCircularAccessPlatform';
import { updateAccessPlatform } from './platform/updateAccessPlatform';
import { addPipeRack } from './rack/addPipeRack';
import { updatePipeRack } from './rack/updatePipeRack';

export const structuresCommands = commandCatalog(
  listAccessRules,
  checkAccess,
  listGratingTypes,
  addGrating,
  updateGrating,
  checkGrating,
  addRailing,
  updateRailing,
  addLadder,
  addSteelStair,
  addAccessPlatform,
  addCircularAccessPlatform,
  updateAccessPlatform,
  accessPlatformTakeoff,
  addPipeRack,
  updatePipeRack,
  accessGraph,
  checkReachability,
  exportAccessPlan,
);
