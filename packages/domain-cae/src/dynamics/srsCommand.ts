/** shock_response_spectrum: maximax absolute-acceleration SRS of a half-sine or a sampled history (TR-DYN-50/51, read-only). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { refuseDyn } from './codes';
import { historyProblem } from './libraryCommands';
import { halfSineSrs, historySrs, octaveFrequencies, type SrsValue } from './math/srs';
import { libraryOf } from './store';

/** Sampling guard (TR-DYN-51): dt <= 1 / (SAMPLES_PER_PERIOD fMax). */
const SAMPLES_PER_PERIOD = 10;
/** Uniform sampling tolerance of a history (relative spread of the steps). */
const UNIFORM_TOLERANCE = 1e-6;
const MAX_FREQUENCIES = 400;

/**
 * @invariant read-only; Smallwood ramp-invariant filter, 1.5-period zero tail per frequency; half-sine sampled at min(T/2000, 1/(400 fn))
 * @failure history not uniform / malformed / unknown -> DYN_HISTORY_INVALID / DYN_HISTORY_UNKNOWN; dt > 1/(10 fMax) -> DYN_SAMPLING_TOO_COARSE;
 *   bad frequencies or Q -> FEA_PARAM_INVALID
 */
export const shockResponseSpectrum = defineCommand({
  name: 'shock_response_spectrum',
  description:
    'Shock response spectrum (maximax, positive and negative absolute acceleration in the input unit, e.g. g) of a base acceleration pulse by the ' +
    "Smallwood ramp-invariant recursive filter. input.kind 'half_sine' { peakG, durationS } (sampled finely per frequency) or 'history' " +
    '{ timeS[], accelG[] } or { history: name of define_time_history with unit g }, uniformly sampled with dt <= 1/(10 fMax) (else ' +
    'DYN_SAMPLING_TOO_COARSE). Q (amplification, commonly 10) is required. Frequencies: frequenciesHz, or fMinHz..fMaxHz every 1/octaveFraction ' +
    'octave (default 6, i.e. 1/6 octave). A zero tail of 1.5 periods of each frequency captures the residual response.',
  annotations: { readOnly: true },
  params: z.object({
    input: z
      .object({
        kind: z.enum(['half_sine', 'history']).describe('Pulse kind.'),
        peakG: z.number().optional().describe('half_sine: peak acceleration (g).'),
        durationS: z.number().optional().describe('half_sine: pulse duration in s.'),
        timeS: z.array(z.number()).optional().describe('history: sample times in s (uniform).'),
        accelG: z.array(z.number()).optional().describe('history: base acceleration samples (g).'),
        history: z.string().optional().describe('history: name of a define_time_history entry in g (instead of timeS / accelG).'),
      })
      .describe('Base acceleration input.'),
    Q: z.number().describe('Amplification factor Q = 1 / (2 zeta) of the SDOF oscillators (> 0.5).'),
    frequenciesHz: z.array(z.number()).optional().describe('Natural frequencies in Hz.'),
    fMinHz: z.number().optional().describe('Lowest frequency in Hz (with fMaxHz, instead of frequenciesHz).'),
    fMaxHz: z.number().optional().describe('Highest frequency in Hz.'),
    octaveFraction: z.number().int().optional().describe('Points per octave between fMinHz and fMaxHz; default 6.'),
  }),
  run: (doc, { input, Q, frequenciesHz, fMinHz, fMaxHz, octaveFraction = 6 }): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseDyn(doc, 'shock_response_spectrum', code, message, [], [path]);
    if (!(Q > 0.5 && Number.isFinite(Q))) return fail('FEA_PARAM_INVALID', 'Q must be > 0.5 (zeta < 1)', 'Q');
    let frequencies: number[];
    if (frequenciesHz !== undefined) frequencies = frequenciesHz;
    else if (fMinHz !== undefined && fMaxHz !== undefined && fMinHz > 0 && fMaxHz >= fMinHz && octaveFraction >= 1)
      frequencies = octaveFrequencies(fMinHz, fMaxHz, octaveFraction);
    else return fail('FEA_PARAM_INVALID', 'give frequenciesHz, or 0 < fMinHz <= fMaxHz (and octaveFraction >= 1)', 'frequenciesHz');
    if (frequencies.length === 0 || frequencies.length > MAX_FREQUENCIES || frequencies.some((f) => !(f > 0 && Number.isFinite(f))))
      return fail('FEA_PARAM_INVALID', `1 to ${MAX_FREQUENCIES} frequencies, each > 0`, 'frequenciesHz');
    const top = Math.max(...frequencies);
    let spectrum: (fn: number) => SrsValue;
    let sampling: string;
    if (input.kind === 'half_sine') {
      const { peakG, durationS } = input;
      if (peakG === undefined || durationS === undefined || !Number.isFinite(peakG) || !(durationS > 0))
        return fail('DYN_HISTORY_INVALID', 'half_sine needs peakG and durationS > 0', 'input');
      spectrum = (fn) => halfSineSrs(fn, Q, peakG, durationS);
      sampling = 'dt = min(T/2000, 1/(400 fn)) per frequency';
    } else {
      let timeS = input.timeS;
      let values = input.accelG;
      if (input.history !== undefined) {
        const library = libraryOf(doc);
        const history = Object.hasOwn(library.histories, input.history) ? library.histories[input.history] : undefined;
        if (history === undefined)
          return refuseDyn(
            doc,
            'shock_response_spectrum',
            'DYN_HISTORY_UNKNOWN',
            `no time history '${input.history}'`,
            [],
            ['input.history'],
          );
        if (history.unit !== 'g')
          return fail('DYN_HISTORY_INVALID', `history '${history.name}' is in ${history.unit}, not g`, 'input.history');
        timeS = history.timeS as number[];
        values = history.values as number[];
      }
      if (timeS === undefined || values === undefined)
        return fail('DYN_HISTORY_INVALID', 'history input needs timeS and accelG (or history)', 'input');
      const problem = historyProblem(timeS, values);
      if (problem !== null) return fail('DYN_HISTORY_INVALID', problem.message, `input.timeS.${problem.index}`);
      const dt = ((timeS.at(-1) ?? 0) - (timeS[0] ?? 0)) / (timeS.length - 1);
      const uneven = timeS.findIndex((t, i) => i > 0 && Math.abs(t - (timeS?.[i - 1] ?? 0) - dt) > UNIFORM_TOLERANCE * dt);
      if (uneven > 0)
        return fail('DYN_HISTORY_INVALID', `the history is not uniformly sampled at step ${uneven}: resample it`, `input.timeS.${uneven}`);
      if (dt > 1 / (SAMPLES_PER_PERIOD * top))
        return fail(
          'DYN_SAMPLING_TOO_COARSE',
          `dt ${significantNumber(dt, 4)} s exceeds 1/(10 x ${significantNumber(top, 6)} Hz)`,
          'input.timeS',
        );
      const samples = values;
      spectrum = (fn) => historySrs(fn, Q, samples, dt);
      sampling = `dt = ${significantNumber(dt, 6)} s from the history`;
    }
    const rows = frequencies.map((fn) => spectrum(fn));
    const peakIndex = rows.reduce((best, row, i) => (row.maximax > (rows[best]?.maximax ?? 0) ? i : best), 0);
    return report(
      doc,
      `shock_response_spectrum: ${frequencies.length} frequencies, Q ${significantNumber(Q, 4)}; peak maximax ${significantNumber(rows[peakIndex]?.maximax ?? 0, 6)} at ${significantNumber(frequencies[peakIndex] ?? 0, 6)} Hz (${sampling}).`,
      {
        fHz: frequencies,
        maximax: rows.map((row) => row.maximax),
        positive: rows.map((row) => row.positive),
        negative: rows.map((row) => row.negative),
        method: 'smallwood_ramp_invariant',
        sampling,
        tail: '1.5 periods of each frequency',
      },
    );
  },
});
