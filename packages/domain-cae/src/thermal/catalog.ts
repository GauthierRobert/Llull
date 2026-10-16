/** PHY-03 thermal FE commands. */

import { commandCatalog } from '@core/commands/schema';
import { defineAmplitude, deleteAmplitude } from './amplitude';
import { addThermalBc, deleteThermalBc, updateThermalBc } from './bcCommands';
import { checkThermal } from './check';
import { setThermalPhysicalConstants } from './constantsCommand';
import { disposeThermalLimit } from './dispose';
import { checkTemperatureLimits } from './limitsCheck';
import { thermalReport } from './report';
import { addTemperatureLimit, deleteTemperatureLimit } from './limitCommands';
import { addCavityRadiation, addThermalContact } from './radiationCommands';
import { setInitialTemperature, setThermalStep } from './stepCommands';

export const thermalCommands = commandCatalog(
  addThermalBc,
  updateThermalBc,
  deleteThermalBc,
  setInitialTemperature,
  defineAmplitude,
  deleteAmplitude,
  setThermalStep,
  setThermalPhysicalConstants,
  addTemperatureLimit,
  deleteTemperatureLimit,
  addCavityRadiation,
  addThermalContact,
  thermalReport,
  checkThermal,
  checkTemperatureLimits,
  disposeThermalLimit,
);
