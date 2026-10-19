/** 05 §5.8 margin commands. */

import { commandCatalog } from '@core/commands/schema';
import { computeMargins } from './computeMargins';
import { disposeMargin } from './disposeMargin';

export const marginCommands = commandCatalog(computeMargins, disposeMargin);
