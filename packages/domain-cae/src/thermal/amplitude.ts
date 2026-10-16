/** define_amplitude / delete_amplitude: time curves that scale thermal BC values (table, sine, ramp sampled to tables). */

import type { Amplitude } from '@core/model/analysis';
import { defineCommand, vec2, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem } from './access';
import { refuseThermal } from './codes';

const MAX_AMPLITUDE_POINTS = 20000;
type Points = Amplitude['points'];

/** Sample times `0, step, 2 step, ...` up to `duration` inclusive (the last point is exactly `duration`). */
function sampleTimes(step: number, duration: number): number[] | null {
  const count = Math.floor(duration / step + 1e-9);
  if (count + 2 > MAX_AMPLITUDE_POINTS) return null;
  const times = Array.from({ length: count + 1 }, (_, i) => Number(significantNumber(i * step, 12)));
  const last = times[times.length - 1] ?? 0;
  if (duration - last > 1e-9 * duration) times.push(duration);
  else times[times.length - 1] = duration;
  return times;
}

/** `amplitude * sin(2 pi t / period)` at the sample times (rounded to 12 digits; exact zeros stay 0). */
export function sineAmplitude(amplitude: number, periodS: number, sampleStepS: number, durationS: number): Points | null {
  const times = sampleTimes(sampleStepS, durationS);
  if (times === null) return null;
  return times.map((t) => [t, cleaned(amplitude * Math.sin((2 * Math.PI * t) / periodS), amplitude)] as const);
}

/** Linear ramp 0 -> `amplitude` over `durationS` (two points, or sampled at `sampleStepS`). */
function rampAmplitude(amplitude: number, durationS: number, sampleStepS: number | undefined): Points | null {
  const times = sampleStepS === undefined ? [0, durationS] : sampleTimes(sampleStepS, durationS);
  if (times === null) return null;
  return times.map((t) => [t, Number(significantNumber((amplitude * t) / durationS, 12))] as const);
}

function cleaned(value: number, scale: number): number {
  return Math.abs(value) < 1e-14 * Math.abs(scale) ? 0 : Number(significantNumber(value, 12));
}

/** Problem text of a table (finite, non-empty, strictly increasing times), or null. */
export function tableProblem(points: Points): string | null {
  if (points.length === 0) return 'the table has no points';
  if (points.some(([t, f]) => !Number.isFinite(t) || !Number.isFinite(f))) return 'times and factors must be finite numbers';
  if (points.some(([t], i) => i > 0 && t <= (points[i - 1]?.[0] ?? 0))) return 'times must be strictly increasing';
  if (points.length > MAX_AMPLITUDE_POINTS) return `at most ${MAX_AMPLITUDE_POINTS} points`;
  return null;
}

/** Linear interpolation of `points` at `t`; the end values hold outside (CalculiX behaviour). */
export function amplitudeAt(points: Points, t: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 1;
  if (t <= first[0]) return first[1];
  if (t >= last[0]) return last[1];
  const upper = points.findIndex(([time]) => time >= t);
  const lo = points[upper - 1] ?? first;
  const hi = points[upper] ?? last;
  return lo[1] + ((hi[1] - lo[1]) * (t - lo[0])) / (hi[0] - lo[0]);
}

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * @affects doc.analysis.cases[analysisId].thermal.amplitudes (adds 1 amplitude, id `am-<step>.<k>`; affected: [amplitudeId])
 * @invariant points strictly increasing in time; sine / ramp sampled deterministically at sampleStepS from 0 to durationS inclusive
 * @failure unknown analysis / non-thermal case; missing or invalid parameters, duplicate name, > 20000 points -> THM_AMPLITUDE_INVALID
 */
export const defineAmplitude = defineCommand({
  name: 'define_amplitude',
  description:
    'Define a named time curve f(t) (a multiplier, dimensionless) that thermal BCs reference with add_thermal_bc amplitude=<id or name>. ' +
    'kind table: points [[timeS, factor], ...] strictly increasing; the end values hold outside. kind sine: factor = amplitude * ' +
    'sin(2 pi t / periodS), sampled every sampleStepS from 0 to durationS inclusive (NAFEMS T3: amplitude 1, periodS 80, a BC value ' +
    'of 100 degC gives 100 sin(pi t/40)). kind ramp: linear from 0 to `amplitude` (default 1) over durationS, optionally sampled. ' +
    'Times in seconds. Returns the amplitude id in affected[0].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Unique name inside the analysis, e.g. "sine40".'),
    kind: z.enum(['table', 'sine', 'ramp']).describe('table | sine | ramp.'),
    points: z.array(vec2('[timeS, factor]')).optional().describe('table only: strictly increasing times (s) with their factors.'),
    amplitude: z.number().optional().describe('sine: peak factor (default 1). ramp: final factor (default 1).'),
    periodS: z.number().optional().describe('sine only: period in seconds, > 0.'),
    sampleStepS: z.number().optional().describe('sine: sampling step in seconds, > 0 (required). ramp: optional sampling step.'),
    durationS: z.number().optional().describe('sine / ramp: curve length in seconds, > 0.'),
  }),
  run: (doc, params): CommandResult => {
    const { analysisId, name, kind } = params;
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'define_amplitude', found.code, found.message, found.ids, found.paths);
    const invalid = (message: string, paths: readonly string[] = []): CommandResult =>
      fail(problem('THM_AMPLITUDE_INVALID', message, [analysisId], paths));
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    if (Object.values(found.thermal.amplitudes).some((existing) => existing.name === name))
      return invalid(`an amplitude named '${name}' exists`, ['name']);
    const { amplitude = 1, periodS, sampleStepS, durationS } = params;
    let points: Points | null;
    let generatedFrom: Amplitude['generatedFrom'];
    if (kind === 'table') {
      if (params.points === undefined) return invalid('a table needs points', ['points']);
      points = params.points;
      generatedFrom = { kind: 'table', params: { points: points.length } };
    } else if (kind === 'sine') {
      if (!positive(periodS) || !positive(sampleStepS) || !positive(durationS) || !Number.isFinite(amplitude))
        return invalid('a sine needs finite amplitude and periodS, sampleStepS, durationS > 0', ['periodS', 'sampleStepS', 'durationS']);
      points = sineAmplitude(amplitude, periodS, sampleStepS, durationS);
      generatedFrom = { kind: 'sine', params: { amplitude, periodS, sampleStepS, durationS } };
    } else {
      if (!positive(durationS) || !Number.isFinite(amplitude) || (sampleStepS !== undefined && !positive(sampleStepS)))
        return invalid('a ramp needs durationS > 0, a finite amplitude and sampleStepS > 0 when given', ['durationS']);
      points = rampAmplitude(amplitude, durationS, sampleStepS);
      generatedFrom = { kind: 'ramp', params: { amplitude, durationS, ...(sampleStepS !== undefined ? { sampleStepS } : {}) } };
    }
    if (points === null) return invalid(`more than ${MAX_AMPLITUDE_POINTS} samples: raise sampleStepS`, ['sampleStepS']);
    const bad = tableProblem(points);
    if (bad !== null) return invalid(bad, ['points']);
    const record: Amplitude = { id: nextId('am'), name, points, generatedFrom };
    const thermal = { ...found.thermal, amplitudes: { ...found.thermal.amplitudes, [record.id]: record } };
    return changed(
      withThermal(doc, found, thermal),
      `define_amplitude: '${record.id}' (${name}) ${kind}, ${points.length} points over ${points[points.length - 1]?.[0]} s in '${analysisId}'.`,
      [record.id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].thermal.amplitudes (removes 1; affected: [amplitudeId])
 * @failure unknown analysis / amplitude -> refusal; amplitude still referenced by a BC -> THM_AMPLITUDE_IN_USE (unchanged doc)
 */
export const deleteAmplitude = defineCommand({
  name: 'delete_amplitude',
  description: 'Remove an amplitude from a heat_* analysis. Refused while a thermal BC still references it.',
  annotations: { destructive: true },
  params: z.object({ analysisId: analysisIdSchema, amplitudeId: z.string().describe('Amplitude id (affected[0] of define_amplitude).') }),
  run: (doc, { analysisId, amplitudeId }): CommandResult => {
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'delete_amplitude', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    if (!Object.hasOwn(found.thermal.amplitudes, amplitudeId))
      return fail(
        problem('THM_AMPLITUDE_NOT_FOUND', `no amplitude '${amplitudeId}' in '${analysisId}'`, [analysisId, amplitudeId], ['amplitudeId']),
      );
    const users = Object.values(found.thermal.bcs).filter((record) => record.amplitude === amplitudeId);
    if (users.length > 0)
      return fail(
        problem('THM_AMPLITUDE_IN_USE', `amplitude '${amplitudeId}' is used by ${users.map((u) => u.id).join(', ')}`, [
          amplitudeId,
          ...users.map((u) => u.id),
        ]),
      );
    const thermal = {
      ...found.thermal,
      amplitudes: Object.fromEntries(Object.entries(found.thermal.amplitudes).filter(([id]) => id !== amplitudeId)),
    };
    return changed(withThermal(doc, found, thermal), `delete_amplitude: removed '${amplitudeId}' from '${analysisId}'.`, [amplitudeId]);
  },
});
