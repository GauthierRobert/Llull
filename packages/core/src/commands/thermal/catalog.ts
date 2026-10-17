/** Thermal analysis (PHY-03): closed-form checks and view factors — read-only queries (FE parts wait for 05 FEA). */

import { commandCatalog } from '../schema';
import { computeViewFactors } from './computeViewFactors';
import { thermalAnalyticCheck } from './analyticCheck';

export const thermalCommands = commandCatalog(thermalAnalyticCheck, computeViewFactors);
