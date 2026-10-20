/** sdof_response / psd_rms / damping_coefficients: pure PHY-09 quick checks (read-only, no solver; TR-DYN-20/40/43, §5.2). */

import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { refuseDyn } from './codes';
import { rayleighFromRatios, rayleighZeta } from './math/damping';
import { DEFAULT_PEAK_FACTOR } from './math/gaussian';
import { asdAt, integrateAsd, spectrumProblem, type AsdPoint } from './math/psd';
import { integrationGrid, meanSquare, modalForms, rmsOf } from './math/randomResponse';
import { frfMagnitude, halfPower, milesGrms, receptance, receptancePeak, STANDARD_GRAVITY, transmissibility } from './math/sdof';
import { whiteNoiseAccelerationRms, whiteNoiseRelativeDisplacementRms } from './math/sdof';
import { spectrumInG2 } from './libraryCommands';
import { spectrumOf } from './store';

const n = (value: number): string => significantNumber(value, 6);
const bandSchema = z.array(z.number()).optional().describe('Integration band [fLowHz, fHighHz]; default: the whole spectrum.');
const MM_PER_M = 1000;

type Resolved = { readonly points: AsdPoint[]; readonly name: string | null; readonly unverified: boolean; readonly grade: string | null };

/** The ASD of a request (library name or inline g^2/Hz breakpoints), or a refusal message with its code. */
function resolveSpectrum(
  doc: CadDocument,
  spectrum: string | undefined,
  points: readonly (readonly number[])[] | undefined,
): Resolved | { readonly code: string; readonly message: string } {
  if ((spectrum === undefined) === (points === undefined))
    return { code: 'DYN_SPECTRUM_INVALID', message: 'give exactly one of spectrum or points' };
  if (spectrum !== undefined) {
    const found = spectrumOf(doc, spectrum);
    if (found === undefined) return { code: 'DYN_SPECTRUM_UNKNOWN', message: `no vibration spectrum '${spectrum}'` };
    return { points: spectrumInG2(found), name: spectrum, unverified: found.unverified, grade: found.source.grade ?? null };
  }
  const problem = spectrumProblem(points ?? []);
  if (problem !== null) return { code: 'DYN_SPECTRUM_INVALID', message: problem.message };
  return { points: (points ?? []).map(([f = 0, w = 0]) => [f, w] as const), name: null, unverified: true, grade: null };
}

function bandOf(points: readonly AsdPoint[], band: readonly number[] | undefined): [number, number] | string {
  const lo = Math.max(points[0]?.[0] ?? 0, band?.[0] ?? 0);
  const hi = Math.min(points.at(-1)?.[0] ?? 0, band?.[1] ?? Number.POSITIVE_INFINITY);
  if (band !== undefined && band.length !== 2) return 'bandHz must be [fLowHz, fHighHz]';
  return hi > lo ? [lo, hi] : 'the band does not overlap the spectrum';
}

const dampingSchema = {
  zeta: z.number().optional().describe('Viscous damping ratio (fraction of critical, 0 < zeta < 1). Give zeta or Q; there is no default.'),
  Q: z.number().optional().describe('Amplification factor Q = 1 / (2 zeta). Give zeta or Q.'),
};

/**
 * @invariant read-only; damping is never defaulted; random input: the exact integral is the answer of record, Miles is reported beside it
 * @failure neither zeta nor Q -> DYN_DAMPING_UNSET; both, or zeta outside (0, 1) -> DYN_DAMPING_INVALID; fnHz <= 0 -> FEA_PARAM_INVALID;
 *   bad spectrum -> DYN_SPECTRUM_INVALID / DYN_SPECTRUM_UNKNOWN
 */
export const sdofResponse = defineCommand({
  name: 'sdof_response',
  description:
    'Single-degree-of-freedom quick check. Give the natural frequency fnHz (Hz) and damping as zeta (fraction of critical) or Q (= 1/(2 zeta)); ' +
    "there is no default damping. input.kind 'harmonic': amplification Q at fn, receptance peak, half-power points and Q estimate, base " +
    "transmissibility. input.kind 'random' with asdG2PerHz (white base ASD, g^2/Hz), spectrum (name) or points [[fHz, g2/Hz], ...]: absolute " +
    'acceleration rms in g and relative displacement rms in mm, integrated EXACTLY (closed form for white noise, adaptive grid otherwise) - the ' +
    "answer of record - with Miles' equation sqrt(pi/2 fn Q W(fn)) beside it for comparison, and the named 3-sigma peak. Use before and after a " +
    'random_response analysis; it never replaces one.',
  annotations: { readOnly: true },
  params: z.object({
    fnHz: z.number().describe('Natural frequency in Hz (> 0).'),
    ...dampingSchema,
    input: z
      .object({
        kind: z.enum(['harmonic', 'random']).describe('harmonic (unit force / base) or random base acceleration.'),
        asdG2PerHz: z.number().optional().describe('random: white base ASD level in g^2/Hz.'),
        spectrum: z.string().optional().describe('random: vibration spectrum name (define_vibration_spectrum).'),
        points: z.array(z.array(z.number())).optional().describe('random: inline ASD breakpoints [[fHz, g2/Hz], ...].'),
      })
      .describe('Excitation.'),
    bandHz: bandSchema,
  }),
  run: (doc, { fnHz, zeta: zetaIn, Q, input, bandHz }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseDyn(doc, 'sdof_response', code, message, [], paths);
    if (!(fnHz > 0 && Number.isFinite(fnHz))) return fail('FEA_PARAM_INVALID', 'fnHz must be > 0', ['fnHz']);
    if (zetaIn === undefined && Q === undefined) return fail('DYN_DAMPING_UNSET', 'give zeta or Q (no default damping)', ['zeta']);
    if (zetaIn !== undefined && Q !== undefined) return fail('DYN_DAMPING_INVALID', 'give zeta or Q, not both', ['Q']);
    const zeta = zetaIn ?? 1 / (2 * (Q ?? 0));
    if (!(zeta > 0 && zeta < 1)) return fail('DYN_DAMPING_INVALID', `zeta ${zeta} must be in (0, 1)`, ['zeta']);
    const q = 1 / (2 * zeta);
    if (input.kind === 'harmonic') {
      if (input.asdG2PerHz !== undefined || input.spectrum !== undefined || input.points !== undefined || bandHz !== undefined)
        return fail('DYN_PARAM_NOT_APPLICABLE', 'harmonic input takes no ASD or band', ['input']);
      const peak = receptancePeak(zeta);
      const hp = halfPower(zeta);
      const data = {
        fnHz,
        zeta,
        Q: q,
        amplificationAtFn: frfMagnitude(receptance(1, zeta)),
        phaseAtFnDeg: -90,
        peak: peak === null ? null : { fHz: fnHz * peak.r, amplification: peak.amplification },
        halfPower: hp === null ? null : { f1Hz: fnHz * hp.r1, f2Hz: fnHz * hp.r2, qEstimate: hp.q },
        transmissibilityAtFn: frfMagnitude(transmissibility(1, zeta)),
      };
      return report(
        doc,
        `sdof_response: fn ${n(fnHz)} Hz, zeta ${n(zeta)} (Q ${n(q)}): amplification ${n(data.amplificationAtFn)} at fn, transmissibility ${n(data.transmissibilityAtFn)}${hp === null ? '' : `, half-power Q ${n(hp.q)}`}.`,
        data,
      );
    }
    const white = input.asdG2PerHz;
    if (white !== undefined && (input.spectrum !== undefined || input.points !== undefined))
      return fail('DYN_SPECTRUM_INVALID', 'give one of asdG2PerHz, spectrum or points', ['input']);
    if (white !== undefined && !(white > 0)) return fail('DYN_SPECTRUM_INVALID', 'asdG2PerHz must be > 0', ['input.asdG2PerHz']);
    const g0Mm = STANDARD_GRAVITY * MM_PER_M;
    let exact: { grms: number; relativeMm: number; method: string; band: [number, number] | null; spectrumGrms: number | null };
    let level: number;
    let spectrumInfo: Resolved | null = null;
    if (white !== undefined && bandHz === undefined) {
      level = white;
      exact = {
        grms: whiteNoiseAccelerationRms(fnHz, zeta, white),
        relativeMm: whiteNoiseRelativeDisplacementRms(fnHz, zeta, white) * MM_PER_M,
        method: 'closed_form_white_noise',
        band: null,
        spectrumGrms: null,
      };
    } else {
      const resolved =
        white !== undefined
          ? { points: [[bandHz?.[0] ?? 0, white] as const, [bandHz?.[1] ?? 0, white] as const], name: null, unverified: true, grade: null }
          : resolveSpectrum(doc, input.spectrum, input.points);
      if ('code' in resolved) return fail(resolved.code, resolved.message, ['input']);
      if (white !== undefined && spectrumProblem(resolved.points) !== null)
        return fail('DYN_SPECTRUM_INVALID', 'bandHz must be 0 < low < high', ['bandHz']);
      spectrumInfo = resolved;
      const band = bandOf(resolved.points, bandHz);
      if (typeof band === 'string') return fail('DYN_SPECTRUM_INVALID', band, ['bandHz']);
      const omega = 2 * Math.PI * fnHz;
      const forms = modalForms(
        { omega: [omega], dampingA: [0], dampingB: [2 * zeta * omega] },
        integrationGrid(resolved.points, band, [{ fHz: fnHz, zeta }]),
      );
      const absolute = { kind: 'absolute' as const, unity: true, scale: 1 };
      const relative = { kind: 'relative' as const, unity: false, scale: g0Mm };
      level = asdAt(resolved.points, fnHz);
      exact = {
        grms: rmsOf(meanSquare(forms, Float64Array.of(1), absolute), absolute),
        relativeMm: rmsOf(meanSquare(forms, Float64Array.of(1), relative), relative),
        method: 'adaptive_grid_simpson',
        band,
        spectrumGrms: integrateAsd(resolved.points, band).rms,
      };
    }
    const miles = milesGrms(fnHz, q, level);
    const data = {
      fnHz,
      zeta,
      Q: q,
      asdAtFnG2PerHz: level,
      milesGrms: miles,
      exactGrms: exact.grms,
      relativeDisplacementRmsMm: exact.relativeMm,
      answerOfRecord: 'exact',
      method: exact.method,
      bandHz: exact.band,
      spectrumGrms: exact.spectrumGrms,
      peakFactor: DEFAULT_PEAK_FACTOR,
      peakG: DEFAULT_PEAK_FACTOR.value * exact.grms,
      peakRelativeDisplacementMm: DEFAULT_PEAK_FACTOR.value * exact.relativeMm,
      g: { value: STANDARD_GRAVITY, unit: 'm/s^2' },
      unverified: spectrumInfo?.unverified ?? false,
      reviewRequired: true,
    };
    return report(
      doc,
      `sdof_response: fn ${n(fnHz)} Hz, Q ${n(q)}: exact ${n(exact.grms)} g rms (answer of record), relative displacement ${n(exact.relativeMm)} mm rms, 3-sigma ${n(data.peakG)} g (named default); Miles ${n(miles)} g (quick check only).`,
      data,
    );
  },
});

/**
 * @invariant read-only; exact log-log segment integrals (TR-DYN-43)
 * @failure bad / unknown spectrum -> DYN_SPECTRUM_INVALID / DYN_SPECTRUM_UNKNOWN
 */
export const psdRms = defineCommand({
  name: 'psd_rms',
  description:
    'Overall rms of an acceleration spectral density: spectrum (name) or points [[fHz, g2/Hz], ...], optionally within bandHz. Returns grms ' +
    '(g), the segments (f1Hz, f2Hz, slope dB/oct, area g^2) integrated exactly on log-log axes, and the source grade / unverified flag.',
  annotations: { readOnly: true },
  params: z.object({
    spectrum: z.string().optional().describe('Vibration spectrum name.'),
    points: z.array(z.array(z.number())).optional().describe('Inline breakpoints [[fHz, g2/Hz], ...].'),
    bandHz: bandSchema,
  }),
  run: (doc, { spectrum, points, bandHz }): CommandResult => {
    const resolved = resolveSpectrum(doc, spectrum, points);
    if ('code' in resolved) return refuseDyn(doc, 'psd_rms', resolved.code, resolved.message, [], ['spectrum']);
    const band = bandOf(resolved.points, bandHz);
    if (typeof band === 'string') return refuseDyn(doc, 'psd_rms', 'DYN_SPECTRUM_INVALID', band, [], ['bandHz']);
    const integral = integrateAsd(resolved.points, band);
    const segments = integral.segments.map((s) => ({ f1Hz: s.f1Hz, f2Hz: s.f2Hz, slopeDbPerOct: s.slopeDbPerOct, areaG2: s.area }));
    return report(
      doc,
      `psd_rms: ${n(integral.rms)} g rms over ${n(band[0])}-${n(band[1])} Hz (${segments.length} segment(s))${resolved.unverified ? '; unverified spectrum' : ''}.`,
      { grms: integral.rms, totalG2: integral.total, bandHz: band, segments, grade: resolved.grade, unverified: resolved.unverified },
    );
  },
});

/**
 * @invariant read-only; zeta(f) = alpha / (2 w) + beta w / 2 (CalculiX *MODAL DAMPING, RAYLEIGH)
 * @failure neither / both inputs, f1 >= f2, zeta outside [0, 1) -> DYN_DAMPING_INVALID
 */
export const dampingCoefficients = defineCommand({
  name: 'damping_coefficients',
  description:
    'Rayleigh damping helper: fromRatios { f1Hz, f2Hz, zeta, zeta2? } gives alpha (1/s) and beta (s) with zeta at f1Hz and zeta2 (default zeta) at ' +
    'f2Hz; fromCoefficients { alpha, beta } gives the ratios. Either way zetaAt lists zeta at fHz (default: f1, the geometric mean and f2), ' +
    'showing the dip between the anchors and the growth outside them.',
  annotations: { readOnly: true },
  params: z.object({
    fromRatios: z
      .object({
        f1Hz: z.number().describe('First anchor in Hz.'),
        f2Hz: z.number().describe('Second anchor in Hz (> f1Hz).'),
        zeta: z.number().describe('Ratio at f1Hz.'),
        zeta2: z.number().optional().describe('Ratio at f2Hz; default zeta.'),
      })
      .optional()
      .describe('Target ratios at two frequencies.'),
    fromCoefficients: z
      .object({ alpha: z.number().describe('Mass coefficient in 1/s.'), beta: z.number().describe('Stiffness coefficient in s.') })
      .optional()
      .describe('Known Rayleigh coefficients.'),
    fHz: z.array(z.number()).optional().describe('Frequencies in Hz to report zeta at.'),
  }),
  run: (doc, { fromRatios, fromCoefficients, fHz }): CommandResult => {
    const fail = (message: string, path: string): CommandResult =>
      refuseDyn(doc, 'damping_coefficients', 'DYN_DAMPING_INVALID', message, [], [path]);
    if ((fromRatios === undefined) === (fromCoefficients === undefined))
      return fail('give exactly one of fromRatios or fromCoefficients', 'fromRatios');
    let alpha: number;
    let beta: number;
    let at: number[];
    if (fromRatios !== undefined) {
      const { f1Hz, f2Hz, zeta } = fromRatios;
      const zeta2 = fromRatios.zeta2 ?? zeta;
      if (!(f1Hz > 0 && f2Hz > f1Hz && zeta >= 0 && zeta < 1 && zeta2 >= 0 && zeta2 < 1))
        return fail('need 0 < f1Hz < f2Hz and 0 <= zeta < 1', 'fromRatios');
      ({ alpha, beta } = rayleighFromRatios(f1Hz, f2Hz, zeta, zeta2));
      at = fHz ?? [f1Hz, Math.sqrt(f1Hz * f2Hz), f2Hz];
    } else {
      ({ alpha, beta } = fromCoefficients ?? { alpha: 0, beta: 0 });
      if (!(alpha >= 0 && beta >= 0 && Number.isFinite(alpha + beta))) return fail('alpha and beta must be >= 0', 'fromCoefficients');
      at = fHz ?? [];
    }
    if (at.some((f) => !(f > 0))) return fail('fHz values must be > 0', 'fHz');
    const zetaAt = at.map((f) => ({ fHz: f, zeta: rayleighZeta(alpha, beta, f) }));
    return report(
      doc,
      `damping_coefficients: alpha ${n(alpha)} 1/s, beta ${n(beta)} s${zetaAt.map((z) => `; zeta ${n(z.zeta)} at ${n(z.fHz)} Hz`).join('')}.`,
      { alpha, beta, zetaAt },
    );
  },
});
