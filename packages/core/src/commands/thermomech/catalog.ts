/** Thermo-mechanical (PHY-04): fits at temperature, CTE conversions, closed-form thermal stress checks — read-only queries. */

import { commandCatalog } from '../schema';
import { fitAtTemperature } from './fitAtTemperature';
import { thermalStressCheck } from './thermalStressCheck';

export const thermomechCommands = commandCatalog(fitAtTemperature, thermalStressCheck);
