/** PHY-03 thermal FE commands. */

import { commandCatalog } from '@core/commands/schema';
import { thermalAnalyticCheck } from './analyticCheck';
import { defineAmplitude } from './amplitude';
import { addThermalBc, updateThermalBc } from './bcCommands';
import { computeViewFactors } from './computeViewFactors';
import { checkThermal } from './check';
import { setThermalPhysicalConstants } from './constantsCommand';
import { disposeThermalLimit } from './dispose';
import { checkTemperatureLimits } from './limitsCheck';
import { addTemperatureLimit } from './limitCommands';
import { addThermalContact, updateThermalContact } from './contactCommands';
import { addCavityRadiation } from './radiationCommands';
import { setInitialTemperature, setThermalStep } from './stepCommands';

export const thermalCommands = commandCatalog(
  addThermalBc,
  updateThermalBc,
  setInitialTemperature,
  defineAmplitude,
  setThermalStep,
  setThermalPhysicalConstants,
  addTemperatureLimit,
  addCavityRadiation,
  addThermalContact,
  updateThermalContact,
  checkThermal,
  checkTemperatureLimits,
  disposeThermalLimit,
  thermalAnalyticCheck,
  computeViewFactors,
);
