/** convert_acoustic_spectrum (PHY-20 FR-VAC-06): third-octave -> octave regrouping into a new spectrum. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseVac, unverifiedItem } from './codes';
import { bandByNominal } from './math/bands';
import { regroupThirdsToOctaves } from './math/regroup';
import { NAME_PATTERN, spectrumOf, withSpectrum } from './model';
import { spectrumName } from './spectrumCommands';
import type { AcousticSpectrum } from './types';

/**
 * @affects doc.vibroacoustics.spectra (adds 1 octave spectrum; affected: [name]); the source spectrum is unchanged
 * @invariant each octave level = energy sum of its three thirds (edges coincide); an octave without all three thirds is omitted and listed; source grade and
 *   unverified are copied, citation reads "regrouped from <spectrum>: <citation>"
 * @failure unknown spectrum -> VAC_SPECTRUM_UNKNOWN; name exists -> VAC_NAME_TAKEN; octave -> third octave, already-octave source, or no complete octave ->
 *   VAC_CONVERSION_UNSUPPORTED (all refusals leave the document unchanged)
 */
export const convertAcousticSpectrum = defineCommand({
  name: 'convert_acoustic_spectrum',
  description:
    'Regroup a third-octave acoustic spectrum into a new octave spectrum by energy sum of the three thirds of each octave (10 log10 sum 10^(L/10), dB re 20 micropascal). ' +
    'An octave is produced only when all three of its thirds are present; the omitted octaves are listed in data.omittedOctavesHz. ' +
    'Octave -> third octave is refused (VAC_CONVERSION_UNSUPPORTED: a split has no information). The source spectrum is kept; the result is a new spectrum `name` with the same source grade. ' +
    'Returns the new name in affected[0] and data { octaves[{ nominalHz, splDb }], omittedOctavesHz }.',
  params: z.object({
    spectrum: spectrumName.describe('Name of the stored third-octave spectrum to convert.'),
    to: z.enum(['octave', 'third_octave']).describe('Target band system: only "octave" is built; "third_octave" is always refused.'),
    name: spectrumName.describe('Name of the new octave spectrum.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseVac(doc, 'convert_acoustic_spectrum', code, message, [params.spectrum], paths);
    const source = spectrumOf(doc, params.spectrum);
    if (source === undefined) return fail('VAC_SPECTRUM_UNKNOWN', `no spectrum '${params.spectrum}'`, ['spectrum']);
    if (!NAME_PATTERN.test(params.name)) return fail('VAC_PARAMS_INVALID', `name '${params.name}' is not a valid spectrum name`, ['name']);
    if (spectrumOf(doc, params.name) !== undefined) return fail('VAC_NAME_TAKEN', `spectrum '${params.name}' exists`, ['name']);
    if (params.to !== 'octave' || source.bandwidth !== 'third_octave')
      return fail(
        'VAC_CONVERSION_UNSUPPORTED',
        params.to !== 'octave'
          ? 'octave -> third octave cannot be split'
          : `'${params.spectrum}' is already an octave spectrum (only third octave -> octave is built)`,
        ['to'],
      );
    const { octaves, omittedOctavesHz } = regroupThirdsToOctaves(source.bands);
    if (octaves.length === 0)
      return fail('VAC_CONVERSION_UNSUPPORTED', `no octave has all three thirds present (omitted: ${omittedOctavesHz.join(', ')} Hz)`, [
        'spectrum',
      ]);
    const result: AcousticSpectrum = {
      name: params.name,
      bandwidth: 'octave',
      reference: '20uPa',
      bands: octaves.flatMap((octave) => {
        const band = bandByNominal('octave', octave.nominalHz);
        return band === undefined ? [] : [{ nominalHz: octave.nominalHz, exactMidHz: band.exactMidHz, splDb: octave.splDb }];
      }),
      source: { ...source.source, citation: `regrouped from ${source.name}: ${source.source.citation}` },
      unverified: source.unverified,
    };
    const omitted = omittedOctavesHz.length === 0 ? '' : `; omitted incomplete octave(s) ${omittedOctavesHz.join(', ')} Hz`;
    return {
      ...changed(
        withSpectrum(doc, result),
        `Regrouped '${source.name}' into octave spectrum '${result.name}' (${octaves.length} bands${omitted})${result.unverified ? '; VAC_SPECTRUM_UNVERIFIED: not grade A' : ''}.`,
        [result.name],
      ),
      data: { octaves, omittedOctavesHz, unverified: result.unverified, items: result.unverified ? [unverifiedItem(result.name)] : [] },
    };
  },
});
