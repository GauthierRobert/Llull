/** PHY-04 thermo-mechanical FE commands. */

import { commandCatalog } from '@core/commands/schema';
import { checkThermoMechanical } from './check';
import { setReferenceTemperature, setTemperatureField } from './commands';
import { disposeFitResult } from './dispose';
import { thermalDistortionReport } from './distortion';
import { setMaterialOrientation } from './orientation';
import { stackupAtTemperature } from './stackup';

export const thermomechCommands = commandCatalog(
  setReferenceTemperature,
  setTemperatureField,
  checkThermoMechanical,
  thermalDistortionReport,
  disposeFitResult,
  setMaterialOrientation,
  stackupAtTemperature,
);
