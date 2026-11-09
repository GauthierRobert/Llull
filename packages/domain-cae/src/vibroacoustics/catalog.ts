/** PHY-20 vibro-acoustics hand-off commands (spectra, conversions, levels, exposures, export package, check). */

import { commandCatalog } from '@core/commands/schema';
import { checkAcousticHandoff } from './checkCommand';
import { convertAcousticSpectrum } from './convertCommand';
import { defineAcousticExposure, deleteAcousticExposure } from './exposureCommands';
import { exportAcousticLoad } from './exportCommand';
import { acousticLevel, acousticSpectrumReport } from './queryCommands';
import { defineAcousticSpectrum, deleteAcousticSpectrum } from './spectrumCommands';

export const vibroacousticsCommands = commandCatalog(
  defineAcousticSpectrum,
  deleteAcousticSpectrum,
  convertAcousticSpectrum,
  acousticLevel,
  acousticSpectrumReport,
  defineAcousticExposure,
  deleteAcousticExposure,
  exportAcousticLoad,
  checkAcousticHandoff,
);
