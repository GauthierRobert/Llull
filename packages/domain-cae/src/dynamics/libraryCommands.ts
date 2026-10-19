/** define_ / delete_vibration_spectrum, define_ / delete_time_history, describe_vibration_library: the PHY-09 document library. */

import type { TimeHistory, VibrationSpectrum } from '@core/model/structuralDynamics';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { refuseDyn } from './codes';
import { LIBRARY_NAMES, SPECTRUM_LIBRARY } from './library';
import { integrateAsd, spectrumProblem } from './math/psd';
import { STANDARD_GRAVITY } from './math/sdof';
import { NAME_PATTERN, libraryOf, sourceOf, spectrumUsers, withLibrary } from './store';

const nameSchema = z.string().describe('Unique name: 1-40 characters of a-z, 0-9 and _.');
const sourceSchema = z.object({
  citation: z.string().describe('Where the values come from (standard, test specification, measurement); never empty.'),
  grade: z.enum(['A', 'B', 'C']).optional().describe('Source grade; anything but A leaves the entry unverified.'),
  url: z.string().optional().describe('Link to the source.'),
});

/** Spectrum levels in g^2/Hz (the unit every PHY-09 integral uses). */
export function spectrumInG2(spectrum: VibrationSpectrum): (readonly [number, number])[] {
  const factor = spectrum.unit === 'g2/Hz' ? 1 : 1 / (STANDARD_GRAVITY * STANDARD_GRAVITY);
  return spectrum.points.map(([f, level]) => [f, level * factor] as const);
}

const nameProblem = (name: string): string | null =>
  NAME_PATTERN.test(name) ? null : `name '${name}' must be 1-40 characters of a-z, 0-9 and _`;

/**
 * @affects doc.analysis.vibration.spectra (adds 1; affected: [name])
 * @invariant exactly one of points / library; library entries copy points, unit, source and grade; unverified unless grade A
 * @failure bad name -> DYN_NAME_INVALID; name taken -> DYN_NAME_TAKEN; both / neither of points and library, bad breakpoints, points without
 *   a citation -> DYN_SPECTRUM_INVALID
 */
export const defineVibrationSpectrum = defineCommand({
  name: 'define_vibration_spectrum',
  description:
    'Define a base-acceleration spectral density (ASD) for random_response cases and quick checks: either points [[fHz, level], ...] with unit ' +
    "g2/Hz (default; g = 9.80665 m/s^2) or (m/s2)2/Hz and source { citation, grade? }, or library 'gevs_component_qual' / " +
    "'gevs_component_accept' (GSFC-STD-7000B component levels as quoted by secondary sources: grade B, so every result driven by them is " +
    'unverified until the standard is read). Levels are interpolated log-log between breakpoints. Returns the overall grms (exact segment integral).',
  params: z.object({
    name: nameSchema,
    points: z
      .array(z.array(z.number()))
      .optional()
      .describe('Breakpoints [[fHz, level], ...], at least 2, strictly increasing fHz > 0, level > 0.'),
    unit: z.enum(['g2/Hz', '(m/s2)2/Hz']).optional().describe('Unit of the levels; default g2/Hz.'),
    library: z
      .enum(['gevs_component_qual', 'gevs_component_accept'])
      .optional()
      .describe('Copy a sourced library spectrum instead of points.'),
    source: sourceSchema.optional().describe('Required with points: where the breakpoints come from.'),
  }),
  run: (doc, { name, points, unit, library, source }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseDyn(doc, 'define_vibration_spectrum', code, message, [name], paths);
    const bad = nameProblem(name);
    if (bad !== null) return fail('DYN_NAME_INVALID', bad, ['name']);
    const current = libraryOf(doc);
    if (Object.hasOwn(current.spectra, name)) return fail('DYN_NAME_TAKEN', `a spectrum '${name}' exists`, ['name']);
    if ((points === undefined) === (library === undefined))
      return fail('DYN_SPECTRUM_INVALID', 'give exactly one of points or library', ['points']);
    let spectrum: VibrationSpectrum;
    if (library !== undefined) {
      if (unit !== undefined || source !== undefined)
        return fail('DYN_SPECTRUM_INVALID', 'a library spectrum carries its own unit and source', ['library']);
      const entry = SPECTRUM_LIBRARY[library];
      spectrum = {
        name,
        quantity: 'acceleration',
        unit: entry.unit,
        points: entry.points,
        source: entry.source,
        unverified: entry.source.grade !== 'A',
        library,
      };
    } else {
      const problem = spectrumProblem(points ?? []);
      if (problem !== null) return fail('DYN_SPECTRUM_INVALID', problem.message, [`points.${problem.index}`]);
      const sourced = sourceOf(source);
      if (sourced === null) return fail('DYN_SPECTRUM_INVALID', 'spectrum points need source { citation }', ['source']);
      spectrum = {
        name,
        quantity: 'acceleration',
        unit: unit ?? 'g2/Hz',
        points: (points ?? []).map(([f = 0, level = 0]) => [f, level] as const),
        source: sourced,
        unverified: sourced.grade !== 'A',
      };
    }
    const grms = integrateAsd(spectrumInG2(spectrum)).rms;
    const next = withLibrary(doc, {
      ...current,
      spectra: { ...current.spectra, [name]: spectrum },
      spectrumOrder: [...current.spectrumOrder, name],
    });
    return changed(
      next,
      `define_vibration_spectrum: '${name}' ${spectrum.points.length} breakpoints ${significantNumber(spectrum.points[0]?.[0] ?? 0, 6)}-${significantNumber(spectrum.points.at(-1)?.[0] ?? 0, 6)} Hz, ${significantNumber(grms, 6)} g rms${spectrum.unverified ? `; UNVERIFIED (source grade ${spectrum.source.grade ?? 'unstated'}): DYN_SPECTRUM_UNVERIFIED` : ''}.`,
      [name],
    );
  },
});

/**
 * @affects doc.analysis.vibration.spectra (removes 1; affected: [name])
 * @failure unknown -> DYN_SPECTRUM_UNKNOWN; used by a case base excitation -> DYN_SPECTRUM_IN_USE
 */
export const deleteVibrationSpectrum = defineCommand({
  name: 'delete_vibration_spectrum',
  description: 'Delete a vibration spectrum. Refused while a random_response case base excitation uses it.',
  annotations: { destructive: true },
  params: z.object({ name: nameSchema }),
  run: (doc, { name }): CommandResult => {
    const current = libraryOf(doc);
    if (!Object.hasOwn(current.spectra, name))
      return refuseDyn(doc, 'delete_vibration_spectrum', 'DYN_SPECTRUM_UNKNOWN', `no vibration spectrum '${name}'`, [name], ['name']);
    const users = spectrumUsers(doc, name);
    if (users.length > 0)
      return refuseDyn(doc, 'delete_vibration_spectrum', 'DYN_SPECTRUM_IN_USE', `spectrum '${name}' drives ${users.join(', ')}`, [
        name,
        ...users,
      ]);
    const spectra = Object.fromEntries(Object.entries(current.spectra).filter(([key]) => key !== name));
    return changed(
      withLibrary(doc, { ...current, spectra, spectrumOrder: current.spectrumOrder.filter((key) => key !== name) }),
      `delete_vibration_spectrum: removed '${name}'.`,
      [name],
    );
  },
});

/** Reason a history table is invalid, or null. */
export function historyProblem(
  timeS: readonly number[],
  values: readonly number[],
): { readonly index: number; readonly message: string } | null {
  if (timeS.length !== values.length) return { index: Math.min(timeS.length, values.length), message: 'timeS and values differ in length' };
  if (timeS.length < 2) return { index: 0, message: 'a history needs at least 2 samples' };
  for (let i = 0; i < timeS.length; i += 1) {
    const [t, v] = [timeS[i] ?? Number.NaN, values[i] ?? Number.NaN];
    if (!Number.isFinite(t) || !Number.isFinite(v)) return { index: i, message: `sample ${i} is not finite` };
    if (i > 0 && !(t > (timeS[i - 1] ?? 0))) return { index: i, message: `sample ${i}: time must strictly increase` };
  }
  return null;
}

/**
 * @affects doc.analysis.vibration.histories (adds 1; affected: [name])
 * @failure bad name -> DYN_NAME_INVALID; taken -> DYN_NAME_TAKEN; unequal lengths, non-increasing time, non-finite, no citation -> DYN_HISTORY_INVALID
 */
export const defineTimeHistory = defineCommand({
  name: 'define_time_history',
  description:
    'Define a time history (s, value) for PHY-09 dynamics: an input to shock_response_spectrum by name, and (V1) to transient cases. unit: ' +
    'factor | N | N*mm | mm | g. Times strictly increasing, values finite, source { citation }. (PHY-07 fatigue histories are define_load_history.)',
  params: z.object({
    name: nameSchema,
    unit: z.enum(['factor', 'N', 'N*mm', 'mm', 'g']).describe('Unit of the values.'),
    timeS: z.array(z.number()).describe('Sample times in s, strictly increasing.'),
    values: z.array(z.number()).describe('Sample values, same length as timeS.'),
    source: sourceSchema.describe('Where the history comes from (measurement, test specification).'),
  }),
  run: (doc, { name, unit, timeS, values, source }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseDyn(doc, 'define_time_history', code, message, [name], paths);
    const bad = nameProblem(name);
    if (bad !== null) return fail('DYN_NAME_INVALID', bad, ['name']);
    const current = libraryOf(doc);
    if (Object.hasOwn(current.histories, name)) return fail('DYN_NAME_TAKEN', `a history '${name}' exists`, ['name']);
    const problem = historyProblem(timeS, values);
    if (problem !== null) return fail('DYN_HISTORY_INVALID', problem.message, [`timeS.${problem.index}`]);
    const sourced = sourceOf(source);
    if (sourced === null) return fail('DYN_HISTORY_INVALID', 'a history needs source { citation }', ['source']);
    const history: TimeHistory = { name, unit, timeS, values, source: sourced, unverified: sourced.grade !== 'A' };
    return changed(
      withLibrary(doc, { ...current, histories: { ...current.histories, [name]: history }, historyOrder: [...current.historyOrder, name] }),
      `define_time_history: '${name}' ${timeS.length} samples over ${significantNumber((timeS.at(-1) ?? 0) - (timeS[0] ?? 0), 6)} s (${unit}).`,
      [name],
    );
  },
});

/**
 * @affects doc.analysis.vibration.histories (removes 1; affected: [name])
 * @failure unknown -> DYN_HISTORY_UNKNOWN
 */
export const deleteTimeHistory = defineCommand({
  name: 'delete_time_history',
  description: 'Delete a PHY-09 time history.',
  annotations: { destructive: true },
  params: z.object({ name: nameSchema }),
  run: (doc, { name }): CommandResult => {
    const current = libraryOf(doc);
    if (!Object.hasOwn(current.histories, name))
      return refuseDyn(doc, 'delete_time_history', 'DYN_HISTORY_UNKNOWN', `no time history '${name}'`, [name], ['name']);
    const histories = Object.fromEntries(Object.entries(current.histories).filter(([key]) => key !== name));
    return changed(
      withLibrary(doc, { ...current, histories, historyOrder: current.historyOrder.filter((key) => key !== name) }),
      `delete_time_history: removed '${name}'.`,
      [name],
    );
  },
});

/** @invariant read-only */
export const describeVibrationLibrary = defineCommand({
  name: 'describe_vibration_library',
  description:
    'List the PHY-09 vibration spectra (name, unit, breakpoints, grms, source, grade, unverified) and time histories of the document, and the ' +
    'built-in library spectrum names usable with define_vibration_spectrum library.',
  annotations: { readOnly: true },
  params: z.object({}),
  run: (doc: CadDocument): CommandResult => {
    const library = libraryOf(doc);
    const spectra = library.spectrumOrder.flatMap((name) => {
      const spectrum = library.spectra[name];
      return spectrum === undefined ? [] : [{ ...spectrum, grms: integrateAsd(spectrumInG2(spectrum)).rms }];
    });
    const histories = library.historyOrder.flatMap((name) => {
      const history = library.histories[name];
      return history === undefined
        ? []
        : [{ name, unit: history.unit, samples: history.timeS.length, source: history.source, unverified: history.unverified }];
    });
    return report(doc, `describe_vibration_library: ${spectra.length} spectrum(s), ${histories.length} history(ies).`, {
      spectra,
      histories,
      builtIn: LIBRARY_NAMES,
    });
  },
});
