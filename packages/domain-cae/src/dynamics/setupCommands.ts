/** set_dynamic_damping / set_frequency_sweep / set_base_excitation / set_dynamic_basis: the dynamic set-up of a case (PHY-09 §4). */

import type { AnalysisCase } from '@core/model/analysis';
import type { BaseExcitation, CaseDynamics, DampingModel, DynamicSource } from '@core/model/structuralDynamics';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { refuseDyn } from './codes';
import { rayleighFromRatios, rayleighZeta } from './math/damping';
import { dynamicCaseOf, sourceOf, spectrumOf, withDynamics, type DynamicCase } from './store';

const sourceSchema = z.object({
  citation: z.string().describe('Where the value comes from (test report, standard, company rule); never empty.'),
  grade: z.enum(['A', 'B', 'C']).optional().describe('Source grade: A >= 2 independent sources, B one secondary source, C unconfirmed.'),
  url: z.string().optional().describe('Link to the source, when there is one.'),
});

const n = (value: number): string => significantNumber(value, 6);

type Fail = (code: string, message: string, paths?: readonly string[]) => CommandResult;

/** The dynamic case or the refusal (unknown id / not a frequency_response or random_response case). */
function lookup(doc: CadDocument, analysisId: string, fail: Fail): DynamicCase | CommandResult {
  const found = dynamicCaseOf(doc, analysisId);
  if (found === 'missing') return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, ['analysisId']);
  if (found === 'not_dynamic')
    return fail('DYN_CASE_TYPE', `analysis '${analysisId}' is not a frequency_response or random_response case`, ['analysisId']);
  return found;
}

const isResult = (value: DynamicCase | CommandResult): value is CommandResult => 'document' in value;

const fraction = (zeta: number): boolean => Number.isFinite(zeta) && zeta >= 0 && zeta < 1;

function citationOf(source: Parameters<typeof sourceOf>[0]): DynamicSource | null {
  return sourceOf(source);
}

/**
 * @affects doc.analysis.cases[analysisId].dynamics.damping (replaced; affected: [analysisId])
 * @invariant one damping model per case; rayleigh_from_ratios stores the inputs and the resolved alpha, beta; no default damping (AF-31)
 * @failure unknown / non-dynamic case -> FEA_ANALYSIS_NOT_FOUND / DYN_CASE_TYPE; zeta outside [0, 1), alpha or beta < 0, f1 >= f2, bad mode
 *   range, empty citation (except structural_material) -> DYN_DAMPING_INVALID; parameters of another model -> DYN_PARAM_NOT_APPLICABLE
 */
export const setDynamicDamping = defineCommand({
  name: 'set_dynamic_damping',
  description:
    'Set the damping of a frequency_response / random_response case (there is NO default damping). model: modal (ratios [{ fromMode, toMode, ' +
    'zeta }], zeta = fraction of critical, e.g. 0.02), rayleigh (alpha 1/s, beta s: zeta_j = alpha/(2 w_j) + beta w_j/2), ' +
    'rayleigh_from_ratios (zeta1 at f1Hz and zeta2 at f2Hz -> alpha, beta resolved and stored; zeta dips between the anchors and grows outside, ' +
    'analysis_report lists the ratio applied per mode) or structural_material (loss factor eta from the structuralLossFactor property model of ' +
    'each part material, written as *DAMPING,STRUCTURAL; zeta_eq = eta/2 at resonance). Every model except structural_material needs ' +
    'source { citation }. Replaces any earlier damping of the case.',
  params: z.object({
    analysisId: analysisIdSchema,
    model: z.enum(['modal', 'rayleigh', 'rayleigh_from_ratios', 'structural_material']).describe('Damping model.'),
    ratios: z
      .array(
        z.object({
          fromMode: z.number().int().describe('First mode of the range (1-based).'),
          toMode: z.number().int().describe('Last mode of the range (inclusive, >= fromMode).'),
          zeta: z.number().describe('Viscous damping ratio, fraction of critical, 0 <= zeta < 1.'),
        }),
      )
      .optional()
      .describe('modal only: damping ratio per mode range; a later range overrides an earlier one for the modes they share.'),
    alpha: z.number().optional().describe('rayleigh only: mass-proportional coefficient alpha in 1/s, >= 0.'),
    beta: z.number().optional().describe('rayleigh only: stiffness-proportional coefficient beta in s, >= 0.'),
    f1Hz: z.number().optional().describe('rayleigh_from_ratios only: first anchor frequency in Hz.'),
    f2Hz: z.number().optional().describe('rayleigh_from_ratios only: second anchor frequency in Hz (> f1Hz).'),
    zeta1: z.number().optional().describe('rayleigh_from_ratios only: damping ratio at f1Hz.'),
    zeta2: z.number().optional().describe('rayleigh_from_ratios only: damping ratio at f2Hz (default zeta1).'),
    source: sourceSchema.optional().describe('Required except for structural_material: where the damping value comes from.'),
  }),
  run: (doc, params): CommandResult => {
    const fail: Fail = (code, message, paths = []) => refuseDyn(doc, 'set_dynamic_damping', code, message, [params.analysisId], paths);
    const found = lookup(doc, params.analysisId, fail);
    if (isResult(found)) return found;
    const { model } = params;
    const allowed: Record<typeof model, readonly string[]> = {
      modal: ['ratios', 'source'],
      rayleigh: ['alpha', 'beta', 'source'],
      rayleigh_from_ratios: ['f1Hz', 'f2Hz', 'zeta1', 'zeta2', 'source'],
      structural_material: [],
    };
    const stray = ['ratios', 'alpha', 'beta', 'f1Hz', 'f2Hz', 'zeta1', 'zeta2', 'source'].find(
      (key) => params[key as keyof typeof params] !== undefined && !allowed[model].includes(key),
    );
    if (stray !== undefined) return fail('DYN_PARAM_NOT_APPLICABLE', `${stray} does not apply to damping model ${model}`, [stray]);
    const source = citationOf(params.source);
    if (model !== 'structural_material' && source === null)
      return fail('DYN_DAMPING_INVALID', 'damping needs source { citation } (damping is never defaulted)', ['source']);
    let damping: DampingModel;
    let note: string;
    if (model === 'modal') {
      const ratios = params.ratios ?? [];
      if (ratios.length === 0) return fail('DYN_DAMPING_INVALID', 'modal damping needs at least one ratio range', ['ratios']);
      const bad = ratios.findIndex((r) => !(r.fromMode >= 1 && r.toMode >= r.fromMode && fraction(r.zeta)));
      if (bad >= 0) return fail('DYN_DAMPING_INVALID', `ratio ${bad} needs 1 <= fromMode <= toMode and 0 <= zeta < 1`, [`ratios.${bad}`]);
      damping = { model, ratios, source: source as DynamicSource };
      note = ratios.map((r) => `modes ${r.fromMode}-${r.toMode} zeta ${n(r.zeta)}`).join(', ');
    } else if (model === 'rayleigh') {
      const { alpha, beta } = params;
      if (
        alpha === undefined ||
        beta === undefined ||
        !(alpha >= 0) ||
        !(beta >= 0) ||
        !Number.isFinite(alpha + beta) ||
        alpha + beta === 0
      )
        return fail('DYN_DAMPING_INVALID', 'rayleigh needs alpha >= 0 (1/s) and beta >= 0 (s), not both 0', ['alpha']);
      damping = { model, alpha, beta, source: source as DynamicSource };
      note = `alpha ${n(alpha)} 1/s, beta ${n(beta)} s`;
    } else if (model === 'rayleigh_from_ratios') {
      const { f1Hz, f2Hz, zeta1 } = params;
      const zeta2 = params.zeta2 ?? zeta1;
      if (
        f1Hz === undefined ||
        f2Hz === undefined ||
        zeta1 === undefined ||
        zeta2 === undefined ||
        !(f1Hz > 0 && f2Hz > f1Hz && Number.isFinite(f2Hz))
      )
        return fail('DYN_DAMPING_INVALID', 'rayleigh_from_ratios needs 0 < f1Hz < f2Hz and zeta1 (and optionally zeta2)', ['f1Hz']);
      if (!(fraction(zeta1) && fraction(zeta2) && zeta1 + zeta2 > 0))
        return fail('DYN_DAMPING_INVALID', 'zeta1 and zeta2 must be in [0, 1), not both 0', ['zeta1']);
      const { alpha, beta } = rayleighFromRatios(f1Hz, f2Hz, zeta1, zeta2);
      if (!(alpha >= 0 && beta >= 0))
        return fail('DYN_DAMPING_INVALID', `these anchors give a negative coefficient (alpha ${n(alpha)}, beta ${n(beta)})`, ['zeta2']);
      damping = { model, f1Hz, f2Hz, zeta1, zeta2, alpha, beta, source: source as DynamicSource };
      const mid = Math.sqrt(f1Hz * f2Hz);
      note = `alpha ${n(alpha)} 1/s, beta ${n(beta)} s (zeta ${n(zeta1)} at ${n(f1Hz)} Hz, ${n(zeta2)} at ${n(f2Hz)} Hz, ${n(rayleighZeta(alpha, beta, mid))} at ${n(mid)} Hz)`;
    } else {
      damping = { model, propertyName: 'structuralLossFactor' };
      note = 'eta from each part material structuralLossFactor (zeta_eq = eta/2 at resonance), checked when the deck is written';
    }
    const next: CaseDynamics = { ...found.dynamics, damping };
    return changed(withDynamics(doc, found.analysisCase, next), `set_dynamic_damping: '${params.analysisId}' ${model} — ${note}.`, [
      params.analysisId,
    ]);
  },
});

/**
 * @affects doc.analysis.cases[analysisId].dynamics.sweep (replaced; affected: [analysisId])
 * @failure non-dynamic case -> DYN_CASE_TYPE; fMin <= 0, fMin >= fMax, points < 2, bias < 1 -> DYN_SWEEP_INVALID
 */
export const setFrequencySweep = defineCommand({
  name: 'set_frequency_sweep',
  description:
    'Set the frequency band of a frequency_response / random_response case (CalculiX *STEADY STATE DYNAMICS): fMinHz, fMaxHz in Hz, ' +
    'pointsPerInterval n (CalculiX default 20, >= 2) and bias (default 3, >= 1: points cluster at the eigenfrequencies; with m modes in the ' +
    'band CalculiX writes n m - m + n points). For a random case the band also bounds the response integral (intersected with the spectrum).',
  params: z.object({
    analysisId: analysisIdSchema,
    fMinHz: z.number().describe('Lower frequency in Hz (> 0).'),
    fMaxHz: z.number().describe('Upper frequency in Hz (> fMinHz).'),
    pointsPerInterval: z.number().int().optional().describe('Data points per interval between fixed frequencies; default 20 (CalculiX).'),
    bias: z.number().optional().describe('Point clustering at the eigenfrequencies; default 3 (CalculiX), 1 = equally spaced.'),
  }),
  run: (doc, params): CommandResult => {
    const fail: Fail = (code, message, paths = []) => refuseDyn(doc, 'set_frequency_sweep', code, message, [params.analysisId], paths);
    const found = lookup(doc, params.analysisId, fail);
    if (isResult(found)) return found;
    const { fMinHz, fMaxHz, pointsPerInterval = 20, bias = 3 } = params;
    if (!(fMinHz > 0 && fMaxHz > fMinHz && Number.isFinite(fMaxHz)))
      return fail('DYN_SWEEP_INVALID', `need 0 < fMinHz < fMaxHz (got ${fMinHz}, ${fMaxHz})`, ['fMinHz']);
    if (!(pointsPerInterval >= 2)) return fail('DYN_SWEEP_INVALID', 'pointsPerInterval must be >= 2', ['pointsPerInterval']);
    if (!(bias >= 1 && Number.isFinite(bias))) return fail('DYN_SWEEP_INVALID', 'bias must be >= 1', ['bias']);
    const defaults = [params.pointsPerInterval === undefined ? 'points 20' : '', params.bias === undefined ? 'bias 3' : ''].filter(Boolean);
    const next: CaseDynamics = { ...found.dynamics, sweep: { fMinHz, fMaxHz, pointsPerInterval, bias } };
    return changed(
      withDynamics(doc, found.analysisCase, next),
      `set_frequency_sweep: '${params.analysisId}' ${n(fMinHz)}-${n(fMaxHz)} Hz, ${pointsPerInterval} points per interval, bias ${n(bias)}${defaults.length > 0 ? ` (CalculiX defaults: ${defaults.join(', ')})` : ''}.`,
      [params.analysisId],
    );
  },
});

const DOF_KEY = { x: 'ux', y: 'uy', z: 'uz' } as const;

/** Whether a constraint of the case fixes translation `direction` homogeneously (what *BASE MOTION drives). */
export function hasBaseConstraint(analysisCase: AnalysisCase, direction: 'x' | 'y' | 'z'): boolean {
  return analysisCase.constraintOrder.some((id) => {
    const constraint = analysisCase.constraints[id];
    if (constraint === undefined) return false;
    if (constraint.kind === 'fixed' || constraint.kind === 'pinned') return true;
    return constraint.kind === 'displacement' && constraint.dofs?.[DOF_KEY[direction]] === 0;
  });
}

/**
 * @affects doc.analysis.cases[analysisId].dynamics.base (replaced; affected: [analysisId])
 * @invariant random_response: spectrum, no amplitudeG; frequency_response: amplitudeG > 0, no spectrum; acceleration base motion only
 * @failure non-dynamic case -> DYN_CASE_TYPE; unknown spectrum -> DYN_SPECTRUM_UNKNOWN; wrong input for the case type -> DYN_BASE_INVALID;
 *   no fixed / pinned / zero-displacement constraint for the direction -> DYN_BASE_NO_CONSTRAINT
 */
export const setBaseExcitation = defineCommand({
  name: 'set_base_excitation',
  description:
    'Shake the base of a frequency_response / random_response case: a uniform base ACCELERATION along direction x | y | z applied by CalculiX ' +
    '*BASE MOTION to every node with a homogeneous constraint on that DOF (add a fixed / pinned / zero-displacement constraint on the base ' +
    'faces first). random_response: spectrum = name of a define_vibration_spectrum ASD (g^2/Hz; single input, fully correlated). ' +
    'frequency_response: amplitudeG = harmonic amplitude in g (9.80665 m/s^2). Replaces any earlier base excitation of the case.',
  params: z.object({
    analysisId: analysisIdSchema,
    direction: z.enum(['x', 'y', 'z']).describe('Translation the base moves along.'),
    kind: z
      .enum(['acceleration'])
      .optional()
      .describe('Base input kind: acceleration (the only one in the MVP; displacement histories for transients are V1).'),
    spectrum: z.string().optional().describe('random_response only: vibration spectrum name (define_vibration_spectrum).'),
    amplitudeG: z.number().optional().describe('frequency_response only: harmonic base acceleration amplitude in g (> 0).'),
  }),
  run: (doc, { analysisId, direction, spectrum, amplitudeG }): CommandResult => {
    const fail: Fail = (code, message, paths = []) => refuseDyn(doc, 'set_base_excitation', code, message, [analysisId], paths);
    const found = lookup(doc, analysisId, fail);
    if (isResult(found)) return found;
    const random = found.analysisCase.type === 'random_response';
    if (random && (spectrum === undefined || amplitudeG !== undefined))
      return fail('DYN_BASE_INVALID', 'a random_response base needs spectrum (and no amplitudeG)', ['spectrum']);
    if (!random && (amplitudeG === undefined || spectrum !== undefined || !(amplitudeG > 0 && Number.isFinite(amplitudeG))))
      return fail('DYN_BASE_INVALID', 'a frequency_response base needs amplitudeG > 0 in g (and no spectrum)', ['amplitudeG']);
    if (spectrum !== undefined && spectrumOf(doc, spectrum) === undefined)
      return fail('DYN_SPECTRUM_UNKNOWN', `no vibration spectrum '${spectrum}'`, ['spectrum']);
    if (!hasBaseConstraint(found.analysisCase, direction))
      return fail(
        'DYN_BASE_NO_CONSTRAINT',
        `analysis '${analysisId}' has no fixed, pinned or zero-displacement constraint on ${direction}: the base motion would drive nothing`,
        ['direction'],
      );
    const base: BaseExcitation = {
      kind: 'acceleration',
      direction,
      ...(spectrum !== undefined ? { spectrum } : {}),
      ...(amplitudeG !== undefined ? { amplitudeG } : {}),
    };
    return changed(
      withDynamics(doc, found.analysisCase, { ...found.dynamics, base }),
      `set_base_excitation: '${analysisId}' base acceleration along ${direction}${spectrum !== undefined ? `, ASD '${spectrum}'` : `, ${n(amplitudeG ?? 0)} g harmonic`}.`,
      [analysisId],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].modes and .dynamics.basis / modalTruncationThreshold (affected: [analysisId])
 * @failure non-dynamic case -> DYN_CASE_TYPE; nothing given, modes outside 1..100, fMaxHz <= 0, threshold outside (0, 1] -> DYN_BASIS_MISSING / FEA_PARAM_INVALID
 */
export const setDynamicBasis = defineCommand({
  name: 'set_dynamic_basis',
  description:
    'Change the modal basis of a frequency_response / random_response case: modes (number of modes CalculiX extracts, 1-100), fMaxHz (Hz: ' +
    'modes above it are not used by the llull post-processing) and modalTruncationThreshold (fraction of total effective mass the kept modes ' +
    'must reach per direction, e.g. 0.9 - a company rule, llull has no default; check_structural_dynamics warns below it).',
  params: z.object({
    analysisId: analysisIdSchema,
    modes: z.number().int().optional().describe('Modes to extract, 1 to 100.'),
    fMaxHz: z.number().optional().describe('Highest frequency of interest in Hz; modes above it are not kept.'),
    modalTruncationThreshold: z.number().optional().describe('Required cumulative effective-mass fraction, 0 < value <= 1.'),
  }),
  run: (doc, { analysisId, modes, fMaxHz, modalTruncationThreshold }): CommandResult => {
    const fail: Fail = (code, message, paths = []) => refuseDyn(doc, 'set_dynamic_basis', code, message, [analysisId], paths);
    const found = lookup(doc, analysisId, fail);
    if (isResult(found)) return found;
    if (modes === undefined && fMaxHz === undefined && modalTruncationThreshold === undefined)
      return fail('DYN_BASIS_MISSING', 'give modes, fMaxHz or modalTruncationThreshold', ['modes']);
    if (modes !== undefined && !(modes >= 1 && modes <= 100))
      return fail('FEA_PARAM_INVALID', `modes ${modes} must be 1 to 100`, ['modes']);
    if (fMaxHz !== undefined && !(fMaxHz > 0 && Number.isFinite(fMaxHz)))
      return fail('FEA_PARAM_INVALID', 'fMaxHz must be > 0', ['fMaxHz']);
    if (modalTruncationThreshold !== undefined && !(modalTruncationThreshold > 0 && modalTruncationThreshold <= 1))
      return fail('FEA_PARAM_INVALID', 'modalTruncationThreshold must be in (0, 1]', ['modalTruncationThreshold']);
    const dynamics: CaseDynamics = {
      ...found.dynamics,
      basis: { ...found.dynamics.basis, ...(fMaxHz !== undefined ? { fMaxHz } : {}) },
      ...(modalTruncationThreshold !== undefined ? { modalTruncationThreshold } : {}),
    };
    const analysisCase: AnalysisCase = { ...found.analysisCase, ...(modes !== undefined ? { modes } : {}) };
    return changed(
      withDynamics(doc, analysisCase, dynamics),
      `set_dynamic_basis: '${analysisId}' ${analysisCase.modes ?? '?'} mode(s)${dynamics.basis.fMaxHz !== undefined ? `, kept up to ${n(dynamics.basis.fMaxHz)} Hz` : ''}${dynamics.modalTruncationThreshold !== undefined ? `, truncation threshold ${n(dynamics.modalTruncationThreshold)}` : ''}.`,
      [analysisId],
    );
  },
});
