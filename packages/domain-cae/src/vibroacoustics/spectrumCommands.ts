/** define_acoustic_spectrum / delete_acoustic_spectrum (PHY-20 FR-VAC-01..03): acoustic spectra of the vibroacoustics slice. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseVac, unverifiedItem } from './codes';
import { bandByNominal, type Bandwidth } from './math/bands';
import { LEVEL_DB_MAX, LEVEL_DB_MIN } from './math/levels';
import { NAME_PATTERN, spectrumOf, vibroacousticsOf, withSpectrum, withoutSpectrum } from './model';
import type { AcousticBand, AcousticSpectrum } from './types';

export const spectrumName = z
  .string()
  .describe('Spectrum name: a letter first, then letters, digits, "_", "." or "-" (max 64 characters). It is the spectrum key.');

const bandwidthSchema = z
  .enum(['octave', 'third_octave'])
  .describe('Band system of the whole spectrum (IEC 61260-1 base 10): octave (31.5 Hz ... 16 kHz) or third_octave (25 Hz ... 20 kHz).');

/**
 * @affects doc.vibroacoustics.spectra (adds 1 spectrum; affected: [name])
 * @invariant bands stored sorted by exact mid-band frequency with nominal label looked up in the base-10 table (never rounded); unverified unless grade 'A'
 * @failure reference missing or not '20uPa' -> VAC_REFERENCE_UNSET; name exists -> VAC_NAME_TAKEN; label not in the table -> VAC_BAND_UNKNOWN;
 *   same band twice -> VAC_BAND_DUPLICATE (all refusals leave the document unchanged)
 */
export const defineAcousticSpectrum = defineCommand({
  name: 'define_acoustic_spectrum',
  description:
    'Store an acoustic spectrum (sound pressure level per octave or one-third-octave band, dB re 20 micropascal in air) as document data, with its source. ' +
    'Bands are given by NOMINAL label in Hz (third octave 25, 31.5, 40 ... 10000, 12500, 16000, 20000; octave 31.5, 63 ... 8000, 16000); the exact mid-band frequencies come from the IEC 61260-1 base-10 system. ' +
    'The `reference` must be stated ("20uPa"): there is no default. The spectrum is flagged unverified unless source.grade is "A". ' +
    'This is a hand-off input: llull does not compute acoustic response (no SEA, no acoustic FE). ' +
    'Next: acoustic_spectrum_report for OASPL, rms pressure and band PSD; convert_acoustic_spectrum for octave levels. Returns the spectrum name in affected[0].',
  params: z.object({
    name: spectrumName,
    bandwidth: bandwidthSchema,
    reference: z
      .string()
      .optional()
      .describe('Reference pressure of every level: must be "20uPa" (20 micropascal, air). Missing or another value is refused.'),
    bands: z
      .array(
        z.object({
          nominalHz: z
            .number()
            .describe('Nominal band label, Hz, exactly as in the series (e.g. 1000, 1250, 31.5). Other values are refused.'),
          splDb: z
            .number()
            .min(LEVEL_DB_MIN)
            .max(LEVEL_DB_MAX)
            .describe('Band sound pressure level, dB re 20 micropascal (rms, band-limited), between -100 and 300.'),
        }),
      )
      .min(1)
      .max(30)
      .describe('The bands of the spectrum, any order, at most one per nominal label.'),
    source: z
      .object({
        citation: z.string().min(1).describe('Where the levels come from (document, table, test report).'),
        grade: z
          .enum(['A', 'B', 'C'])
          .optional()
          .describe('Confidence in the source: A = read from the primary document; absent or B / C = unverified.'),
        url: z.string().optional().describe('Link to the source.'),
      })
      .describe('Provenance of the levels (required).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseVac(doc, 'define_acoustic_spectrum', code, message, [params.name], paths);
    if (params.reference !== '20uPa')
      return fail(
        'VAC_REFERENCE_UNSET',
        `reference must be '20uPa', got ${params.reference === undefined ? 'nothing' : `'${params.reference}'`}`,
        ['reference'],
      );
    if (!NAME_PATTERN.test(params.name)) return fail('VAC_PARAMS_INVALID', `name '${params.name}' is not a valid spectrum name`, ['name']);
    if (spectrumOf(doc, params.name) !== undefined) return fail('VAC_NAME_TAKEN', `spectrum '${params.name}' exists`, ['name']);
    const bandwidth: Bandwidth = params.bandwidth;
    const bands: AcousticBand[] = [];
    const seen = new Set<number>();
    for (const [index, band] of params.bands.entries()) {
      const geometry = bandByNominal(bandwidth, band.nominalHz);
      if (geometry === undefined)
        return fail('VAC_BAND_UNKNOWN', `${band.nominalHz} Hz is not a nominal ${bandwidth} label`, [`bands[${index}].nominalHz`]);
      if (seen.has(geometry.x)) return fail('VAC_BAND_DUPLICATE', `band ${band.nominalHz} Hz appears twice`, [`bands[${index}].nominalHz`]);
      seen.add(geometry.x);
      bands.push({ nominalHz: geometry.nominalHz, exactMidHz: geometry.exactMidHz, splDb: band.splDb });
    }
    bands.sort((a, b) => a.exactMidHz - b.exactMidHz);
    const spectrum: AcousticSpectrum = {
      name: params.name,
      bandwidth,
      reference: '20uPa',
      bands,
      source: {
        citation: params.source.citation,
        ...(params.source.grade === undefined ? {} : { grade: params.source.grade }),
        ...(params.source.url === undefined ? {} : { url: params.source.url }),
      },
      unverified: params.source.grade !== 'A',
    };
    const items = spectrum.unverified ? [unverifiedItem(spectrum.name)] : [];
    return {
      ...changed(
        withSpectrum(doc, spectrum),
        `Defined acoustic spectrum '${spectrum.name}' (${bandwidth}, ${bands.length} bands, ${bands[0]?.nominalHz} to ${bands[bands.length - 1]?.nominalHz} Hz, dB re 20 uPa)${spectrum.unverified ? '; VAC_SPECTRUM_UNVERIFIED: not grade A' : ''}.`,
        [spectrum.name],
      ),
      data: { name: spectrum.name, bandCount: bands.length, unverified: spectrum.unverified, items },
    };
  },
});

/**
 * @affects doc.vibroacoustics.spectra (removes 1 spectrum)
 * @failure unknown name -> VAC_SPECTRUM_UNKNOWN; referenced by an exposure -> VAC_SPECTRUM_IN_USE (unchanged doc)
 */
export const deleteAcousticSpectrum = defineCommand({
  name: 'delete_acoustic_spectrum',
  description: 'Delete a stored acoustic spectrum that no acoustic exposure uses (refused with VAC_SPECTRUM_IN_USE otherwise).',
  annotations: { destructive: true },
  params: z.object({ name: spectrumName }),
  run: (doc, params): CommandResult => {
    if (spectrumOf(doc, params.name) === undefined)
      return refuseVac(doc, 'delete_acoustic_spectrum', 'VAC_SPECTRUM_UNKNOWN', `no spectrum '${params.name}'`, [params.name], ['name']);
    const users = Object.values(vibroacousticsOf(doc).exposures)
      .filter((exposure) => exposure.spectrum === params.name)
      .map((exposure) => exposure.name);
    if (users.length > 0)
      return refuseVac(
        doc,
        'delete_acoustic_spectrum',
        'VAC_SPECTRUM_IN_USE',
        `spectrum '${params.name}' is used by exposure(s) ${users.join(', ')}`,
        [params.name, ...users],
        ['name'],
      );
    return changed(withoutSpectrum(doc, params.name), `Deleted acoustic spectrum '${params.name}'.`, [params.name]);
  },
});
