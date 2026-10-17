/** 05 §5.8 margin commands. */

import { commandCatalog } from '@core/commands/schema';
import { computeMargins } from './computeMargins';

export const marginCommands = commandCatalog(computeMargins);
