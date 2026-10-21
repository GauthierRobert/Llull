/** PHY-09 structural dynamics commands (frequency / random response, quick checks). */

import { commandCatalog } from '@core/commands/schema';
import { checkDynamics } from './check';
import {
  defineTimeHistory,
  defineVibrationSpectrum,
  deleteTimeHistory,
  deleteVibrationSpectrum,
  describeVibrationLibrary,
} from './libraryCommands';
import { dampingCoefficients, psdRms, sdofResponse } from './quickChecks';
import { setBaseExcitation, setDynamicBasis, setDynamicDamping, setFrequencySweep } from './setupCommands';
import { shockResponseSpectrum } from './srsCommand';
import { equivalentStaticLoadCase } from './reportCommands';

export const dynamicsCommands = commandCatalog(
  setDynamicDamping,
  setFrequencySweep,
  setBaseExcitation,
  setDynamicBasis,
  defineVibrationSpectrum,
  deleteVibrationSpectrum,
  defineTimeHistory,
  deleteTimeHistory,
  describeVibrationLibrary,
  checkDynamics,
  sdofResponse,
  psdRms,
  dampingCoefficients,
  shockResponseSpectrum,
  equivalentStaticLoadCase,
);
