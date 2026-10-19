/** 05 FR-FEA-21 analytic sanity checks. */

import { commandCatalog } from '@core/commands/schema';
import { analyticCheck } from './analyticCheck';

export const analyticCommands = commandCatalog(analyticCheck);
