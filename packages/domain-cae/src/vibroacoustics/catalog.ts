/** PHY-20 vibro-acoustics hand-off commands (spectra, conversions, levels; exposures and export are M2). */

import { commandCatalog } from '@core/commands/schema';
import { convertAcousticSpectrum } from './convertCommand';
import { acousticLevel, acousticSpectrumReport } from './queryCommands';
import { defineAcousticSpectrum, deleteAcousticSpectrum } from './spectrumCommands';

export const vibroacousticsCommands = commandCatalog(
  defineAcousticSpectrum,
  deleteAcousticSpectrum,
  convertAcousticSpectrum,
  acousticLevel,
  acousticSpectrumReport,
);
