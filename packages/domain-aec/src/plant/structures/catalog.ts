/** Plant structures and access commands (06 STA): the `structuresPlugin` catalog. */

import { commandCatalog } from '@core/commands/schema';
import { checkAccess } from './access/checkAccess';
import { listAccessRules } from './access/listAccessRules';

export const structuresCommands = commandCatalog(listAccessRules, checkAccess);
