/** create_crack_growth_case / delete_crack_growth_case / set_damage_tolerance_factors (PHY-08 FR-FRC-05, 09). */

import type { CrackGrowthCase, DamageToleranceFactors } from '@core/model/durability';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { quantitySchema } from '../shared/schemas';
import { growthCaseOf, withGrowthCase, withoutGrowthCase } from '../fatigue/store';
import { refuseFracture } from './codes';
import { sizeLimit } from './kSolutions';
import { isFailure, resolveGrowth } from './setup';

const factorSchema = z
  .object({
    value: z.number().describe('Scatter factor >= 1.'),
    source: z.string().describe('Mandatory source of the factor (regulation, company rule, case input).'),
  })
  .describe('Scatter factor with its source.');

const length = (what: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  quantitySchema.describe(`${what}: a length { value > 0, unit }.`);

const factorFields = {
  scatterThreshold: factorSchema.optional().describe('Factor on the threshold life (aInitial -> critical). No default.'),
  scatterInterval: factorSchema.optional().describe('Factor on the inspection interval life (aDetectable -> critical). No default.'),
  marginalBand: z.number().optional().describe('Margin band (>= 0) for check_damage_tolerance. No default.'),
};

/** `current` with the given factors, or a problem text. */
function mergeFactors(
  current: DamageToleranceFactors,
  input: {
    scatterThreshold?: { value: number; source: string } | undefined;
    scatterInterval?: { value: number; source: string } | undefined;
    marginalBand?: number | undefined;
  },
): DamageToleranceFactors | string {
  for (const [name, factor] of [
    ['scatterThreshold', input.scatterThreshold],
    ['scatterInterval', input.scatterInterval],
  ] as const)
    if (factor !== undefined && (!(factor.value >= 1) || factor.source.trim() === ''))
      return `${name} needs value >= 1 and a non-empty source`;
  if (input.marginalBand !== undefined && !(input.marginalBand >= 0)) return 'marginalBand must be >= 0';
  return {
    ...current,
    ...(input.scatterThreshold !== undefined ? { scatterThreshold: input.scatterThreshold } : {}),
    ...(input.scatterInterval !== undefined ? { scatterInterval: input.scatterInterval } : {}),
    ...(input.marginalBand !== undefined ? { marginalBand: input.marginalBand } : {}),
  };
}

/**
 * @affects doc.analysis.durability.crackGrowthCases (adds 1 case; affected: [caseId])
 * @invariant ids `cg-<step>.<k>`; integration.maxDaOverA defaults to 0.01 (named); no retardation; the crack, both material models and the stress histories must resolve
 * @failure unknown crack / history / model, bad units or sizes -> FRC_CRACK_NOT_FOUND / FRC_CASE_INVALID / FRC_MODEL_MISSING / FRC_UNITS_MISMATCH / FRC_FACTOR_INVALID (unchanged doc)
 */
export const createCrackGrowthCase = defineCommand({
  name: 'create_crack_growth_case',
  description:
    'Create a crack-growth / damage-tolerance case: a crack (define_crack), a growth law and a toughness model of a material record (add_material_model: da_dn_paris | da_dn_walker | ' +
    'da_dn_forman | da_dn_nasgro | da_dn_table, and fracture_toughness), and stress histories (define_load_history, stress kind, MPa; tensile cycles drive growth, DeltaK uses the tensile part of each cycle). ' +
    'growth.aInitial is the starting size; aDetectable (inspection) and aTarget (stop size) are optional; residualStrengthStress is the stress the critical size is computed at (default: the peak stress of the history). ' +
    'sequence cycle_by_cycle applies consecutive reversal pairs as half cycles, rainflow_blocks the rainflow cycles per block; no retardation. Returns the case id in affected[0]. Next: ' +
    'set_damage_tolerance_factors, compute_crack_growth, compute_inspection_interval, check_damage_tolerance.',
  params: z.object({
    name: z.string().min(1).describe('Display name of the case.'),
    crackId: z.string().describe('Crack id (affected[0] of define_crack).'),
    material: z
      .object({
        recordId: z.string().describe('Material record id.'),
        growthModelId: z.string().describe('Id of the crack-growth law on the record.'),
        toughnessModelId: z.string().describe('Id of the fracture_toughness model on the record.'),
      })
      .describe('Material data: record and model ids.'),
    histories: z
      .array(
        z.object({ historyId: z.string().describe('Stress history id.'), scale: z.number().describe('Multiplier on the history values.') }),
      )
      .describe('Stress histories of one block (superposed when several series of the same length). Needs >= 1.'),
    sequence: z.enum(['cycle_by_cycle', 'rainflow_blocks']).optional().describe('cycle_by_cycle (default) | rainflow_blocks.'),
    integration: z
      .object({ maxDaOverA: z.number().describe('Largest relative step da/a of the integration, in (0, 0.5].') })
      .optional()
      .describe('Integration control (default maxDaOverA 0.01).'),
    growth: z
      .object({
        aInitial: length('aInitial: crack size at the start'),
        aDetectable: length('aDetectable: size an inspection can detect (NDE), with its source in your report')
          .optional()
          .describe('Detectable size; needed by compute_inspection_interval.'),
        aTarget: length('aTarget: stop size')
          .optional()
          .describe('Optional stop size; growth ends there if it comes before the critical size.'),
      })
      .describe('Crack sizes: half-length for centre cracks, depth for edge cracks.'),
    residualStrengthStress: quantitySchema
      .optional()
      .describe('Stress { value, unit } at which the critical size is computed (default: peak stress of the histories).'),
    factors: z.object(factorFields).optional().describe('Optional initial factors (see set_damage_tolerance_factors).'),
  }),
  run: (doc, params): CommandResult => {
    const id = nextId('cg');
    const factors = mergeFactors({}, params.factors ?? {});
    if (typeof factors === 'string') return refuseFracture(doc, 'create_crack_growth_case', 'FRC_FACTOR_INVALID', factors, [], ['factors']);
    const maxDaOverA = params.integration?.maxDaOverA ?? 0.01;
    if (!(maxDaOverA > 0 && maxDaOverA <= 0.5))
      return refuseFracture(
        doc,
        'create_crack_growth_case',
        'FRC_PARAMS_INVALID',
        'integration.maxDaOverA must be in (0, 0.5]',
        [],
        ['integration'],
      );
    if (params.histories.length === 0)
      return refuseFracture(doc, 'create_crack_growth_case', 'FRC_CASE_INVALID', 'histories needs >= 1 entry', [], ['histories']);
    const growthCase: CrackGrowthCase = {
      id,
      name: params.name,
      crackId: params.crackId,
      material: params.material,
      histories: params.histories,
      sequence: params.sequence ?? 'cycle_by_cycle',
      integration: { maxDaOverA },
      growth: params.growth,
      ...(params.residualStrengthStress !== undefined ? { residualStrengthStress: params.residualStrengthStress } : {}),
      factors,
    };
    const setup = resolveGrowth(doc, growthCase);
    if (isFailure(setup)) return refuseFracture(doc, 'create_crack_growth_case', setup.code, setup.message, setup.ids, ['crackId']);
    if (setup.a0 > sizeLimit(setup.geometry))
      return refuseFracture(
        doc,
        'create_crack_growth_case',
        'FRC_K_SOLUTION_OUT_OF_RANGE',
        'growth.aInitial is beyond the validity of the K solution',
        [params.crackId],
        ['growth.aInitial'],
      );
    return changed(
      withGrowthCase(doc, growthCase),
      `Created crack-growth case ${id} '${params.name}' (${setup.modelKind}, a0 = ${(setup.a0 * 1000).toPrecision(5)} mm, ${setup.cyclesPerBlock} cycle(s) per block, ${growthCase.sequence}); defaults: maxDaOverA ${maxDaOverA}, no retardation; scatter factors NOT set.`,
      [id],
    );
  },
});

/**
 * @affects doc.analysis.durability.crackGrowthCases (removes 1 case)
 * @failure unknown id -> FRC_CASE_NOT_FOUND (unchanged doc)
 */
export const deleteCrackGrowthCase = defineCommand({
  name: 'delete_crack_growth_case',
  description: 'Delete a crack-growth case (its crack and histories stay).',
  annotations: { destructive: true },
  params: z.object({ caseId: z.string().describe('Crack-growth case id.') }),
  run: (doc, params): CommandResult => {
    if (growthCaseOf(doc, params.caseId) === undefined)
      return refuseFracture(
        doc,
        'delete_crack_growth_case',
        'FRC_CASE_NOT_FOUND',
        `no crack-growth case '${params.caseId}'`,
        [params.caseId],
        ['caseId'],
      );
    return changed(withoutGrowthCase(doc, params.caseId), `Deleted crack-growth case ${params.caseId}.`, [params.caseId]);
  },
});

/**
 * @affects doc.analysis.durability.crackGrowthCases[caseId].factors (merges the given fields)
 * @invariant a factor needs value >= 1 and a source; nothing is defaulted
 * @failure unknown case -> FRC_CASE_NOT_FOUND; invalid factor -> FRC_FACTOR_INVALID (unchanged doc)
 */
export const setDamageToleranceFactors = defineCommand({
  name: 'set_damage_tolerance_factors',
  description:
    'Set the named factors of a crack-growth case: scatterThreshold and scatterInterval {value >= 1, source} (NO default: ask the owner) and marginalBand. ' +
    'compute_inspection_interval divides the life from aDetectable to the critical size by scatterInterval.',
  params: z.object({ caseId: z.string().describe('Crack-growth case id.'), ...factorFields }),
  run: (doc, params): CommandResult => {
    const current = growthCaseOf(doc, params.caseId);
    if (current === undefined)
      return refuseFracture(
        doc,
        'set_damage_tolerance_factors',
        'FRC_CASE_NOT_FOUND',
        `no crack-growth case '${params.caseId}'`,
        [params.caseId],
        ['caseId'],
      );
    const factors = mergeFactors(current.factors, params);
    if (typeof factors === 'string')
      return refuseFracture(doc, 'set_damage_tolerance_factors', 'FRC_FACTOR_INVALID', factors, [params.caseId], ['factors']);
    const text = (name: string, factor: { value: number; source: string } | undefined): string =>
      factor === undefined ? `${name} NOT set` : `${name} ${factor.value} (${factor.source})`;
    return changed(
      withGrowthCase(doc, { ...current, factors }),
      `Set factors of ${current.id}: ${text('scatterThreshold', factors.scatterThreshold)}, ${text('scatterInterval', factors.scatterInterval)}.`,
      [current.id],
    );
  },
});
