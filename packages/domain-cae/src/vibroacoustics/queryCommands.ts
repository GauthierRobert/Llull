/** acoustic_level / acoustic_spectrum_report (PHY-20 FR-VAC-02, 04, 05): read-only level, OASPL and band-PSD queries. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseVac, unverifiedItem } from './codes';
import { bandByNominal } from './math/bands';
import { energySumDb, LEVEL_DB_MAX, LEVEL_DB_MIN, overallPressurePa, pressureToSpl, splToPressure } from './math/levels';
import { bandPsd } from './math/psd';
import { regroupThirdsToOctaves } from './math/regroup';
import { spectrumOf } from './model';
import { spectrumName } from './spectrumCommands';

const levelDb = z.number().min(LEVEL_DB_MIN).max(LEVEL_DB_MAX);

/**
 * @affects nothing; read-only, data { pRmsPa, splDb, sumDb? }
 * @invariant p = p0 10^(L/20), p0 = 2e-5 Pa; exactly one of splDb / pRmsPa / levelsDb; levelsDb is an energy sum 10 log10 sum 10^(Li/10)
 * @failure none or several inputs, pRmsPa <= 0 -> VAC_PARAMS_INVALID (unchanged doc)
 */
export const acousticLevel = defineCommand({
  name: 'acoustic_level',
  annotations: { readOnly: true },
  description:
    'Convert between sound pressure level (dB re 20 micropascal, air) and rms pressure (Pa), or sum band levels by energy. Give exactly one of: splDb (returns pRmsPa), ' +
    'pRmsPa (returns splDb) or levelsDb (returns sumDb = 10 log10 sum 10^(L/10), the overall level, plus its pRmsPa). p = 2e-5 Pa * 10^(L/20). ' +
    'Example: splDb 140 gives pRmsPa 200. Pure arithmetic: no document data is read or written.',
  params: z.object({
    splDb: levelDb.optional().describe('A sound pressure level, dB re 20 micropascal (-100 to 300).'),
    pRmsPa: z.number().positive().max(1e12).optional().describe('An rms sound pressure, Pa (> 0).'),
    levelsDb: z.array(levelDb).min(1).max(10000).optional().describe('Band levels to add by energy, dB re 20 micropascal.'),
  }),
  run: (doc, params): CommandResult => {
    const { splDb, pRmsPa, levelsDb } = params;
    const given = [splDb, pRmsPa, levelsDb].filter((value) => value !== undefined).length;
    const answer = (level: number, pressure: number): CommandResult =>
      report(doc, `acoustic_level: ${level.toPrecision(12)} dB re 20 uPa = ${pressure.toPrecision(12)} Pa rms.`, {
        pRmsPa: pressure,
        splDb: level,
      });
    if (given === 1 && splDb !== undefined) return answer(splDb, splToPressure(splDb));
    if (given === 1 && pRmsPa !== undefined) return answer(pressureToSpl(pRmsPa), pRmsPa);
    if (given === 1 && levelsDb !== undefined) {
      const sumDb = energySumDb(levelsDb);
      const pressure = splToPressure(sumDb);
      return report(
        doc,
        `acoustic_level: energy sum of ${levelsDb.length} levels = ${sumDb.toPrecision(12)} dB re 20 uPa (${pressure.toPrecision(12)} Pa rms).`,
        { pRmsPa: pressure, splDb: sumDb, sumDb },
      );
    }
    return refuseVac(
      doc,
      'acoustic_level',
      'VAC_PARAMS_INVALID',
      `give exactly one of splDb, pRmsPa, levelsDb (got ${given})`,
      [],
      ['splDb', 'pRmsPa', 'levelsDb'],
    );
  },
});

/**
 * @affects nothing; read-only, data { oasplDb, pRmsPa, bands[], octaves?, omittedOctavesHz?, psdKind, unverified, items }
 * @invariant OASPL = energy sum of the bands; psd = p^2 / (f2 - f1) is band-averaged, one-sided, Pa^2/Hz; octaves (third-octave spectra) need all three thirds
 * @failure unknown spectrum -> VAC_SPECTRUM_UNKNOWN (unchanged doc)
 */
export const acousticSpectrumReport = defineCommand({
  name: 'acoustic_spectrum_report',
  annotations: { readOnly: true },
  description:
    'Report a stored acoustic spectrum: overall level OASPL (energy sum of the bands, dB re 20 micropascal), overall rms pressure (Pa) and per band the exact mid, lower and upper edge and bandwidth (Hz), ' +
    'level, rms pressure (Pa) and band-averaged one-sided pressure PSD psdPa2PerHz = p^2/(f2 - f1) (Pa^2/Hz; an average over the band, not a narrow-band value). ' +
    'Third-octave spectra also return the octave regrouping (octaves[], and omittedOctavesHz for octaves lacking a third). Carries the VAC_SPECTRUM_UNVERIFIED warning when not grade A. ' +
    'Example: 27 thirds at 130 dB give OASPL 144.313637642 dB. Response analysis (SEA, acoustic FE) is out of scope: export the spectrum to an acoustic analyst.',
  params: z.object({ spectrum: spectrumName.describe('Name of the stored spectrum (define_acoustic_spectrum).') }),
  run: (doc, params): CommandResult => {
    const spectrum = spectrumOf(doc, params.spectrum);
    if (spectrum === undefined)
      return refuseVac(
        doc,
        'acoustic_spectrum_report',
        'VAC_SPECTRUM_UNKNOWN',
        `no spectrum '${params.spectrum}'`,
        [params.spectrum],
        ['spectrum'],
      );
    const levels = spectrum.bands.map((band) => band.splDb);
    const oasplDb = energySumDb(levels);
    const pRmsPa = overallPressurePa(levels);
    const bands = spectrum.bands.flatMap((band) => {
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
    const regrouped = spectrum.bandwidth === 'third_octave' ? regroupThirdsToOctaves(spectrum.bands) : undefined;
    const items = spectrum.unverified ? [unverifiedItem(spectrum.name)] : [];
    return report(
      doc,
      `acoustic_spectrum_report '${spectrum.name}': OASPL ${oasplDb.toPrecision(12)} dB re 20 uPa, ${pRmsPa.toPrecision(12)} Pa rms over ${bands.length} ${spectrum.bandwidth} bands; PSD is band-averaged (Pa^2/Hz)${spectrum.unverified ? '; VAC_SPECTRUM_UNVERIFIED: not grade A' : ''}.`,
      {
        spectrum: spectrum.name,
        bandwidth: spectrum.bandwidth,
        reference: spectrum.reference,
        oasplDb,
        pRmsPa,
        psdKind: 'band-averaged one-sided Pa^2/Hz',
        bands,
        ...(regrouped === undefined ? {} : { octaves: regrouped.octaves, omittedOctavesHz: regrouped.omittedOctavesHz }),
        source: spectrum.source,
        unverified: spectrum.unverified,
        items,
      },
    );
  },
});
