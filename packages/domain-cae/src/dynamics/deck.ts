/**
 * PHY-09 deck sections (§5.6, TR-DYN-03 / TR-DYN-30): the constraints in model data, the base amplitude, a `*FREQUENCY,STORAGE=YES` step
 * (mode shapes U, and S for random cases) and a `*STEADY STATE DYNAMICS` step with `*MODAL DAMPING`, `*BASE MOTION` and the loads.
 * Random cases write the same steady-state step with a 1 g base acceleration as the CalculiX cross-check; llull's own transfer functions
 * (randomResponse.ts) are the result of record. Structural damping is a material card `*DAMPING,STRUCTURAL=eta`.
 */

import type { DampingModel } from '@core/model/structuralDynamics';
import { isDeckRefusal, type DeckContext, type DeckRefusal, type DeckSections } from '../decks/context';
import { commentText, linesText, num, row } from '../decks/format';
import { boundaryData, mechanicalStepLines } from '../decks/mechanical';
import { caseLossFactor, lossFactorOf } from './materialDamping';
import { hasBaseConstraint } from './setupCommands';
import { spectrumOf } from './store';
import { gravityInUnitSystem } from './units';

const refuse = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });

const DOF = { x: 1, y: 2, z: 3 } as const;
/** Name of the base-motion amplitude (frequency - factor pairs over the sweep). */
const BASE_AMPLITUDE = 'A_BASE';

/**
 * Material cards of a dynamic case: `*DAMPING,STRUCTURAL=eta` for structural_material damping, else none.
 * @failure no / refused structuralLossFactor -> DYN_MATERIAL_NO_DAMPING
 */
export function dynamicMaterialCards(ctx: DeckContext, entityId: string): DeckSections {
  if (ctx.analysis.dynamics?.damping?.model !== 'structural_material') return { text: '' };
  const eta = lossFactorOf(ctx.doc, ctx.analysis, entityId);
  if ('code' in eta) return refuse(eta.code, eta.message, eta.ids);
  return { text: linesText([`*DAMPING,STRUCTURAL=${num(eta.eta)}`]) };
}

function modalDampingLines(damping: DampingModel): string[] {
  if (damping.model === 'modal') return ['*MODAL DAMPING', ...damping.ratios.map((r) => row(r.fromMode, r.toMode, r.zeta))];
  if (damping.model === 'structural_material') return [];
  return ['*MODAL DAMPING, RAYLEIGH', `,,${num(damping.alpha)},${num(damping.beta)}`];
}

/** Displacement probe prints of the steady-state step (`*NODE PRINT`, real then imaginary tables in the .dat). */
function probePrints(ctx: DeckContext): string[] {
  return Object.keys(ctx.analysis.probes)
    .filter((id) => (ctx.mesh.nodeSets[`P_${id}`]?.length ?? 0) > 0)
    .flatMap((id) => [`*NODE PRINT, NSET=${ctx.nset(`P_${id}`)}`, 'U']);
}

/**
 * Model-data constraints, base amplitude, frequency step and steady-state step of a frequency_response / random_response case.
 * @failure no modes -> DYN_BASIS_MISSING; no damping -> DYN_DAMPING_UNSET; no sweep -> DYN_SWEEP_UNSET; random without base / unknown
 *   spectrum -> DYN_BASE_UNSET / DYN_SPECTRUM_UNKNOWN; base without a homogeneous constraint -> DYN_BASE_NO_CONSTRAINT; frequency response
 *   without load or base -> FEA_NO_LOADS; structural damping refusals; unresolved targets -> FEA_TARGET_UNRESOLVED
 */
export function dynamicSections(ctx: DeckContext): DeckSections {
  const { analysis, analysisId } = ctx;
  const dynamics = analysis.dynamics;
  const random = analysis.type === 'random_response';
  const ids = [analysisId];
  if (analysis.modes === undefined) return refuse('DYN_BASIS_MISSING', `analysis '${analysisId}' has no number of modes`, ids);
  if (dynamics?.damping === undefined)
    return refuse('DYN_DAMPING_UNSET', `analysis '${analysisId}' has no damping (no default damping)`, ids);
  if (dynamics.damping.model === 'structural_material') {
    const eta = caseLossFactor(ctx.doc, analysis);
    if ('code' in eta) return refuse(eta.code, eta.message, eta.ids);
  }
  const sweep = dynamics.sweep;
  if (sweep === undefined) return refuse('DYN_SWEEP_UNSET', `analysis '${analysisId}' has no frequency sweep`, ids);
  const base = dynamics.base;
  if (random && base === undefined) return refuse('DYN_BASE_UNSET', `random_response '${analysisId}' has no base excitation`, ids);
  if (base?.spectrum !== undefined && spectrumOf(ctx.doc, base.spectrum) === undefined)
    return refuse('DYN_SPECTRUM_UNKNOWN', `no vibration spectrum '${base.spectrum}'`, [base.spectrum]);
  if (base !== undefined && !hasBaseConstraint(analysis, base.direction))
    return refuse('DYN_BASE_NO_CONSTRAINT', `no homogeneous constraint on ${base.direction} for the base motion`, ids);
  if (!random && base === undefined && analysis.loadOrder.length === 0)
    return refuse('FEA_NO_LOADS', `frequency_response '${analysisId}' has no load and no base excitation`, ids);
  const boundary = boundaryData(ctx);
  if (!Array.isArray(boundary)) return boundary;
  const loads = random ? { text: '' } : mechanicalStepLines(ctx, undefined, { scale: () => 1, parameters: '', boundary: false });
  if (isDeckRefusal(loads)) return loads;
  const g = gravityInUnitSystem(ctx.unitSystem);
  const amplitude = (base?.amplitudeG ?? 1) * g;
  const lines = [
    `** PHY-09 ${analysis.type}: modal basis ${analysis.modes} mode(s), sweep ${num(sweep.fMinHz)}-${num(sweep.fMaxHz)} Hz`,
    ...(boundary.length > 0 ? ['*BOUNDARY', ...boundary] : []),
    ...(base === undefined ? [] : [`*AMPLITUDE, NAME=${BASE_AMPLITUDE}`, row(sweep.fMinHz, amplitude, sweep.fMaxHz, amplitude)]),
    '*STEP',
    '*FREQUENCY, STORAGE=YES',
    num(analysis.modes),
    '*NODE FILE',
    'U',
    ...(random ? ['*EL FILE', 'S'] : []),
    '*END STEP',
    `** steady-state ${random ? `cross-check: 1 g base acceleration along ${base?.direction ?? '?'} (llull transfer functions are the result of record)` : 'response'}`,
    '*STEP',
    '*STEADY STATE DYNAMICS',
    row(sweep.fMinHz, sweep.fMaxHz, sweep.pointsPerInterval, sweep.bias),
    ...modalDampingLines(dynamics.damping),
    ...(base === undefined ? [] : [`*BASE MOTION, DOF=${DOF[base.direction]}, AMPLITUDE=${BASE_AMPLITUDE}, TYPE=ACCELERATION`]),
    ...loads.text.split('\n').filter((line) => line !== ''),
    ...probePrints(ctx),
    ...(random ? [] : ['*NODE FILE', 'U', '*EL FILE', 'S']),
    '*END STEP',
  ];
  if (base?.spectrum !== undefined) lines.splice(1, 0, `** base ASD '${commentText(base.spectrum)}' applied by llull post-processing`);
  return { text: linesText(lines) };
}
