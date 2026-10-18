/** fatigue_life (PHY-07 FR-FAT-01..04): quick life check at one stress or strain amplitude, no FE. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { MeanStressModel } from '@core/model/durability';
import { findCurve, isCurveRefusal } from './curves';
import { refuseFatigue } from './codes';
import { localResponse, stressAtStrain, strainLifeAt, stressLifeDamage, type StrainMeanModel } from './damage';
import { cyclicCurveOf, notchFactor, toMpa, transitionReversals } from './lifeMath';
import {
  MEAN_STRESS_TEXT,
  meanStressSchema,
  modifierProblem,
  modifierSchema,
  NOTCH_TEXT,
  notchProblem,
  notchSchema,
  stressQuantity,
} from './schemas';
import { meanInputsFor, meanModelName } from './meanInputs';
import { strengthMpa } from './curves';
import { item, REVIEW_NOTE, type Item } from './items';

const COMMAND = 'fatigue_life';
const STRESS_KINDS = ['sn_basquin', 'sn_power_law', 'sn_table'] as const;

const paramsSchema = z.object({
  method: z.enum(['stress_life', 'strain_life']).describe('stress_life (S-N) or strain_life (epsilon-N).'),
  material: z.string().describe('Material record id (define_material_record / create_material name) holding the models.'),
  modelId: z.string().describe('Id of the S-N or en_coffin_manson model on that material (add_material_model).'),
  cyclicModelId: z.string().optional().describe('strain_life with nominal stress or SWT: id of the cyclic_ramberg_osgood model.'),
  amplitude: stressQuantity.optional().describe('stress_life: stress amplitude (half range).'),
  mean: stressQuantity.optional().describe('stress_life: mean stress (default 0).'),
  nominal: z
    .object({ amplitude: stressQuantity, mean: stressQuantity.optional().describe('Mean nominal stress (default 0).') })
    .optional()
    .describe('strain_life: nominal stress amplitude and mean; local response by Neuber when a notch is given.'),
  strainAmplitude: z.number().optional().describe('strain_life: total strain amplitude (> 0), alternative to `nominal`.'),
  notch: notchSchema.optional().describe(NOTCH_TEXT),
  meanStress: meanStressSchema.optional().describe(`${MEAN_STRESS_TEXT} Default none.`),
  compressiveMean: z.enum(['no_benefit', 'formula']).optional().describe('Compressive mean rule (default no_benefit).'),
  modifiers: z
    .array(modifierSchema)
    .optional()
    .describe('stress_life: Marin modifiers (surface, size, reliability ...), each with a justification.'),
});

/**
 * @affects nothing; read-only, data { method, cyclesToFailure, reversalsToFailure, equivalentAmplitudeMPa, localStressMaxMPa?, localStrainMax?, transitionReversals?, extrapolated, items, unverified, reviewRequired: true }
 * @invariant stress-life: 2Nf = (sigma_ar / (sigma'f * modifiers))^(1/b) on Basquin; strain-life: Newton on log10(2N) of Coffin-Manson-Basquin / Morrow / SWT; Neuber on the cyclic curve for a notch
 * @failure unknown record / model -> FAT_CURVE_MISSING; wrong kind -> FAT_CURVE_UNSUPPORTED; missing Ftu / Fty -> FAT_ALLOWABLE_MISSING; amplitude >= Ftu -> row FAT_STATIC_FAILURE (no life);
 *   bad inputs -> FAT_PARAMS_INVALID / FAT_FACTOR_INVALID (all refusals leave the document unchanged)
 */
export const fatigueLife = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Quick fatigue life at ONE stress or strain amplitude (no FE, no document change). method stress_life: material record + modelId of an S-N model ' +
    '(sn_basquin, sn_power_law, sn_table) and a stress `amplitude` (+ `mean`, `meanStress` model, Marin `modifiers` that multiply the curve strength, e.g. surface 0.8). ' +
    'method strain_life: modelId of an en_coffin_manson model and EITHER `strainAmplitude` OR `nominal` { amplitude, mean } with an optional `notch` { kt, q, feIncludesKt } ' +
    '(needs cyclicModelId, a cyclic_ramberg_osgood model: Neuber local stress / strain, then CMB, Morrow or SWT life). Returns data { cyclesToFailure, reversalsToFailure, ' +
    'equivalentAmplitudeMPa, localStressMaxMPa, localStrainMax, transitionReversals, extrapolated, items[], unverified, reviewRequired }. ' +
    'An amplitude at or above Ftu returns item FAT_STATIC_FAILURE and no life. Results are not approved: a qualified engineer must review.',
  params: paramsSchema,
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseFatigue(doc, COMMAND, code, message, [params.material], paths);
    const meanModel: MeanStressModel = params.meanStress ?? 'none';
    const modifiers = params.modifiers ?? [];
    const modifierIssue = modifierProblem(modifiers);
    if (modifierIssue !== null) return fail('FAT_FACTOR_INVALID', modifierIssue, ['modifiers']);
    const notchIssue = params.notch === undefined ? null : notchProblem(params.notch);
    if (notchIssue !== null) return fail('FAT_PARAMS_INVALID', notchIssue, ['notch']);
    const kf = params.notch === undefined || params.notch.feIncludesKt ? null : notchFactor(params.notch.kt, params.notch.q);
    const items: Item[] = [];
    const result =
      params.method === 'stress_life'
        ? stressLifeResult(doc, params, meanModel, modifiers, kf, items)
        : strainLifeResult(doc, params, meanModel, kf, items);
    if ('refusal' in result) return fail(result.refusal.code, result.refusal.message, result.refusal.paths);
    const { data, unverifiedReasons } = result;
    const unverified = unverifiedReasons.length > 0;
    if (unverified)
      items.push(
        item('FAT_CURVE_UNVERIFIED', 'warning', `curve data unverified: ${unverifiedReasons.join('; ')}`, 'use a verified, sourced curve'),
      );
    if (data['extrapolated'] === true)
      items.push(item('FAT_CURVE_EXTRAPOLATED', 'warning', 'life outside the tested range of the curve', 'use a curve covering the range'));
    const cycles = data['cyclesToFailure'] as number | null;
    const text = items.some((entry) => entry.code === 'FAT_STATIC_FAILURE')
      ? 'static failure (amplitude/max stress >= Ftu), no fatigue life'
      : cycles === null
        ? 'no life (infinite / below the endurance limit)'
        : `${cycles.toPrecision(8)} cycles (${(2 * cycles).toPrecision(8)} reversals)`;
    return report(doc, `fatigue_life ${params.method}: ${text}${unverified ? ', UNVERIFIED data' : ''}. ${REVIEW_NOTE}`, {
      ...data,
      items,
      unverified,
      unverifiedReasons,
      reviewRequired: true,
    });
  },
});

interface Refusal {
  readonly refusal: { readonly code: string; readonly message: string; readonly paths: string[] };
}
interface Computed {
  readonly data: Record<string, unknown>;
  readonly unverifiedReasons: readonly string[];
}
type Params = z.output<typeof paramsSchema>;

const refusal = (code: string, message: string, paths: string[] = []): Refusal => ({ refusal: { code, message, paths } });

function stressLifeResult(
  doc: CadDocument,
  params: Params,
  meanModel: MeanStressModel,
  modifiers: NonNullable<Params['modifiers']>,
  kf: number | null,
  items: Item[],
): Computed | Refusal {
  const curve = findCurve(doc, params.material, params.modelId, STRESS_KINDS);
  if (isCurveRefusal(curve)) return refusal(curve.code, curve.message, ['modelId']);
  if (curve.law.kind === 'sn_table' && curve.law.measure !== 'amplitude')
    return refusal('FAT_CURVE_UNSUPPORTED', 'sn_table with measure max is not supported', ['modelId']);
  const amplitudeQuantity = params.amplitude ?? params.nominal?.amplitude;
  const sa = amplitudeQuantity === undefined ? null : toMpa(amplitudeQuantity);
  const meanQuantity = params.mean ?? params.nominal?.mean;
  const sm = meanQuantity === undefined ? 0 : toMpa(meanQuantity);
  if (sa === null || sm === null || !(sa > 0))
    return refusal('FAT_PARAMS_INVALID', 'stress_life needs a stress amplitude > 0 (and a stress mean)', ['amplitude']);
  const mean = meanInputsFor(doc, params.material, meanModel, params.compressiveMean ?? 'no_benefit', curve.law);
  if ('missing' in mean) return refusal('FAT_ALLOWABLE_MISSING', mean.missing, ['meanStress']);
  const modifierProduct = modifiers.reduce((product, entry) => product * entry.value, 1);
  const ftu = strengthMpa(doc, params.material, 'Ftu');
  const scale = kf ?? 1;
  const sum = stressLifeDamage([{ from: sm - sa, to: sm + sa, range: 2 * sa, mean: sm, count: 1 }], {
    curve: curve.law,
    modifierProduct,
    mean,
    ftu,
    stressScale: scale,
  });
  const staticFailure = sum.flags.has('static_failure');
  if (staticFailure)
    items.push(
      item(
        'FAT_STATIC_FAILURE',
        'fail',
        `max stress ${((sm + sa) * scale).toFixed(1)} MPa >= Ftu ${ftu ?? Number.NaN} MPa`,
        'static redesign (margins) first',
        [params.material],
      ),
    );
  if (sum.flags.has('swt_nonpositive'))
    items.push(item('FAT_SWT_NONPOSITIVE', 'info', 'max stress <= 0 under SWT / Walker: no damage', ''));
  const cycles = staticFailure || sum.damage === 0 ? null : 1 / sum.damage;
  return {
    data: {
      method: 'stress_life',
      curve: { recordId: params.material, modelId: params.modelId, kind: curve.law.kind, basis: curve.entry.basis },
      meanStress: meanModelName(meanModel),
      cyclesToFailure: cycles,
      reversalsToFailure: cycles === null ? null : 2 * cycles,
      equivalentAmplitudeMPa: sum.maxEquivalentAmplitude,
      modifierProduct,
      extrapolated: sum.extrapolated,
    },
    unverifiedReasons: curve.unverifiedReasons,
  };
}

function strainLifeResult(
  doc: CadDocument,
  params: Params,
  meanModel: MeanStressModel,
  kf: number | null,
  items: Item[],
): Computed | Refusal {
  const curve = findCurve(doc, params.material, params.modelId, ['en_coffin_manson']);
  if (isCurveRefusal(curve)) return refusal(curve.code, curve.message, ['modelId']);
  if (!(typeof meanModel === 'string' && (meanModel === 'none' || meanModel === 'morrow' || meanModel === 'swt')))
    return refusal('FAT_MEAN_MODEL_UNSUPPORTED', `strain_life does not support meanStress ${meanModelName(meanModel)}`, ['meanStress']);
  const mean: StrainMeanModel = meanModel;
  const cyclicFound =
    params.cyclicModelId === undefined ? null : findCurve(doc, params.material, params.cyclicModelId, ['cyclic_ramberg_osgood']);
  if (isCurveRefusal(cyclicFound)) return refusal(cyclicFound.code, cyclicFound.message, ['cyclicModelId']);
  const cyclic = cyclicFound === null ? null : cyclicCurveOf(cyclicFound.law);
  if (cyclicFound !== null && cyclic === null)
    return refusal('FAT_CURVE_UNSUPPORTED', 'cyclic model has non-positive parameters', ['cyclicModelId']);
  const meanStressMpa =
    params.nominal?.mean === undefined ? (params.mean === undefined ? 0 : toMpa(params.mean)) : toMpa(params.nominal.mean);
  if (meanStressMpa === null) return refusal('FAT_PARAMS_INVALID', 'mean must be a stress', ['mean']);
  let response;
  if (params.strainAmplitude !== undefined) {
    if (!(params.strainAmplitude > 0)) return refusal('FAT_PARAMS_INVALID', 'strainAmplitude must be > 0', ['strainAmplitude']);
    if (cyclic === null && mean === 'swt')
      return refusal('FAT_PARAMS_INVALID', 'swt with strainAmplitude needs cyclicModelId', ['cyclicModelId']);
    const sigmaA = cyclic === null ? 0 : stressAtStrain(cyclic, params.strainAmplitude);
    response = { sigmaA, epsA: params.strainAmplitude, sigmaMax: sigmaA + meanStressMpa, sigmaMean: meanStressMpa };
  } else {
    const nominalAmplitude = params.nominal === undefined ? null : toMpa(params.nominal.amplitude);
    if (nominalAmplitude === null || !(nominalAmplitude > 0))
      return refusal('FAT_PARAMS_INVALID', 'strain_life needs strainAmplitude or nominal.amplitude > 0', ['nominal']);
    if (cyclic === null) return refusal('FAT_PARAMS_INVALID', 'nominal stress input needs cyclicModelId', ['cyclicModelId']);
    response = localResponse(cyclic, nominalAmplitude, meanStressMpa, kf);
  }
  const reversals = strainLifeAt(curve.law, response, mean);
  if (reversals === null)
    return refusal('FAT_SOLVER_NO_CONVERGENCE', 'the strain-life equation has no solution for these inputs', ['modelId']);
  if (!Number.isFinite(reversals)) items.push(item('FAT_SWT_NONPOSITIVE', 'info', 'max stress <= 0 under SWT: no damage', ''));
  const cycles = Number.isFinite(reversals) ? reversals / 2 : null;
  return {
    data: {
      method: 'strain_life',
      curve: { recordId: params.material, modelId: params.modelId, kind: 'en_coffin_manson', basis: curve.entry.basis },
      meanStress: mean,
      cyclesToFailure: cycles,
      reversalsToFailure: cycles === null ? null : reversals,
      equivalentAmplitudeMPa: response.sigmaA,
      localStressMaxMPa: response.sigmaMax,
      localStrainMax: response.epsA,
      transitionReversals: transitionReversals(curve.law),
      kf,
      extrapolated: false,
    },
    unverifiedReasons: [...curve.unverifiedReasons, ...(cyclicFound === null ? [] : cyclicFound.unverifiedReasons)],
  };
}
