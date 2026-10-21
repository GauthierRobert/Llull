/** 05 FR-FEA-21 analytic sanity checks. */

import { commandCatalog } from '@core/commands/schema';
import { handCheck } from './handCheck';

export const analyticCommands = commandCatalog(handCheck);
