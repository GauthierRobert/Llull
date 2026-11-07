/** Access to and validation of the vibro-acoustics slice of the document (`CadDocument.vibroacoustics`, plugin `physics-vibroacoustics`). */

import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import type { CadDocument } from '@core/model/types';
import { bandByNominal } from './math/bands';
import { LEVEL_DB_MAX, LEVEL_DB_MIN } from './math/levels';
import type { AcousticSpectrum, VibroacousticsModel } from './types';

const EMPTY: VibroacousticsModel = { spectra: {}, spectrumOrder: [], exposures: {}, exposureOrder: [] };

export const vibroacousticsOf = (doc: CadDocument): VibroacousticsModel => doc.vibroacoustics ?? EMPTY;

export const spectrumOf = (doc: CadDocument, name: string): AcousticSpectrum | undefined => {
  const { spectra } = vibroacousticsOf(doc);
  return Object.hasOwn(spectra, name) ? spectra[name] : undefined;
};

export const withSpectrum = (doc: CadDocument, spectrum: AcousticSpectrum): CadDocument => {
  const model = vibroacousticsOf(doc);
  return {
    ...doc,
    vibroacoustics: {
      ...model,
      spectra: { ...model.spectra, [spectrum.name]: spectrum },
      spectrumOrder: model.spectrumOrder.includes(spectrum.name) ? model.spectrumOrder : [...model.spectrumOrder, spectrum.name],
    },
  };
};

export const withoutSpectrum = (doc: CadDocument, name: string): CadDocument => {
  const model = vibroacousticsOf(doc);
  const spectra = Object.fromEntries(Object.entries(model.spectra).filter(([key]) => key !== name));
  return { ...doc, vibroacoustics: { ...model, spectra, spectrumOrder: model.spectrumOrder.filter((entry) => entry !== name) } };
};

/** Name rule shared by the commands and the slice schema: a letter first (`__proto__`, `constructor`, `prototype` refused), then letters, digits, `_`, `.`, `-`. */
export const NAME_PATTERN = /^(?!(?:constructor|prototype)$)[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const nameSchema = z.string().regex(NAME_PATTERN);
const levelSchema = z.number().min(LEVEL_DB_MIN).max(LEVEL_DB_MAX);

const spectrumSchema = z.strictObject({
  name: nameSchema,
  bandwidth: z.enum(['octave', 'third_octave']),
  reference: z.literal('20uPa'),
  bands: z.array(z.strictObject({ nominalHz: z.number(), exactMidHz: z.number(), splDb: levelSchema })).min(1),
  source: z.strictObject({ citation: z.string().min(1), grade: z.enum(['A', 'B', 'C']).optional(), url: z.string().optional() }),
  unverified: z.boolean(),
});

const exposureSchema = z.strictObject({
  name: nameSchema,
  spectrum: nameSchema,
  target: z.strictObject({ entityId: z.string(), facesNear: z.array(z.tuple([z.number(), z.number(), z.number()])) }),
  field: z.enum(['diffuse', 'progressive']),
  incidenceDeg: z.number().optional(),
  notes: z.string().optional(),
});

const sliceSchema = z
  .strictObject({
    spectra: z.record(z.string(), spectrumSchema),
    spectrumOrder: z.array(z.string()),
    exposures: z.record(z.string(), exposureSchema),
    exposureOrder: z.array(z.string()),
  })
  .superRefine((slice, ctx) => {
    const bad = (path: (string | number)[], message: string): void => ctx.addIssue({ code: 'custom', path, message });
    const keysMatch = (order: readonly string[], keys: string[]): boolean =>
      order.length === keys.length && new Set(order).size === keys.length && keys.every((key) => order.includes(key));
    if (!keysMatch(slice.spectrumOrder, Object.keys(slice.spectra))) bad(['spectrumOrder'], 'must list each spectrum key exactly once');
    if (!keysMatch(slice.exposureOrder, Object.keys(slice.exposures))) bad(['exposureOrder'], 'must list each exposure key exactly once');
    for (const [key, spectrum] of Object.entries(slice.spectra)) {
      if (spectrum.name !== key) bad(['spectra', key, 'name'], `must equal its key '${key}'`);
      if (spectrum.unverified !== (spectrum.source.grade !== 'A')) bad(['spectra', key, 'unverified'], 'must be true unless grade is A');
      let previous = Number.NEGATIVE_INFINITY;
      spectrum.bands.forEach((band, index) => {
        const geometry = bandByNominal(spectrum.bandwidth, band.nominalHz);
        if (geometry === undefined) bad(['spectra', key, 'bands', index, 'nominalHz'], 'is not a nominal label of the band system');
        else if (geometry.exactMidHz !== band.exactMidHz)
          bad(['spectra', key, 'bands', index, 'exactMidHz'], 'does not match its nominal label');
        if (band.exactMidHz <= previous) bad(['spectra', key, 'bands', index, 'exactMidHz'], 'bands must be sorted and unique');
        previous = band.exactMidHz;
      });
    }
    for (const [key, exposure] of Object.entries(slice.exposures)) {
      if (exposure.name !== key) bad(['exposures', key, 'name'], `must equal its key '${key}'`);
      if (!Object.hasOwn(slice.spectra, exposure.spectrum)) bad(['exposures', key, 'spectrum'], `names no spectrum '${exposure.spectrum}'`);
    }
  });

/** Value errors of the raw `vibroacoustics` slice (persistence rejects the file when non-empty). */
export const vibroacousticsErrors = (raw: Record<string, unknown>): string[] =>
  raw['vibroacoustics'] === undefined ? [] : sliceSchemaErrors(sliceSchema, raw['vibroacoustics'], 'vibroacoustics');
