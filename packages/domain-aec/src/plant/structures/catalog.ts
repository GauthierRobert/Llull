/** Plant structures and access commands (06 STA): the `structuresPlugin` catalog. */

import { commandCatalog } from '@core/commands/schema';
import { checkAccess } from './access/checkAccess';
import { listAccessRules } from './access/listAccessRules';
import { addGrating } from './grating/addGrating';
import { checkGrating } from './grating/checkGrating';
import { listGratingTypes } from './grating/listGratingTypes';
import { updateGrating } from './grating/updateGrating';
import { addRailing } from './railing/addRailing';
import { updateRailing } from './railing/updateRailing';

export const structuresCommands = commandCatalog(
  listAccessRules,
  checkAccess,
  listGratingTypes,
  addGrating,
  updateGrating,
  checkGrating,
  addRailing,
  updateRailing,
);
