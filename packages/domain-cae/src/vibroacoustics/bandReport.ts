/** Per-band rows of an acoustic spectrum (edges, bandwidth, rms pressure, band-averaged PSD) shared by the report and the export package. */

import { bandByNominal } from './math/bands';
import { splToPressure } from './math/levels';
import { bandPsd } from './math/psd';
import type { AcousticSpectrum } from './types';

export interface BandRow {
  readonly nominalHz: number;
  readonly exactMidHz: number;
  readonly lowerHz: number;
  readonly upperHz: number;
  readonly bandwidthHz: number;
  readonly splDb: number;
  readonly pRmsPa: number;
  readonly psdPa2PerHz: number;
}

/** Rows in the stored (ascending exactMidHz) order; the psd is p^2 / (f2 - f1), band-averaged, one-sided, Pa^2/Hz. */
export const bandRows = (spectrum: AcousticSpectrum): BandRow[] =>
  spectrum.bands.flatMap((band) => {
    const geometry = bandByNominal(spectrum.bandwidth, band.nominalHz);
    if (geometry === undefined) return [];
    return [
      {
        nominalHz: band.nominalHz,
        exactMidHz: band.exactMidHz,
        lowerHz: geometry.lowerHz,
        upperHz: geometry.upperHz,
        bandwidthHz: geometry.bandwidthHz,
        splDb: band.splDb,
        pRmsPa: splToPressure(band.splDb),
        psdPa2PerHz: bandPsd(band.splDb, geometry.lowerHz, geometry.upperHz),
      },
    ];
  });
