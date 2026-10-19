/** create_fatigue_case / update_fatigue_case / delete_fatigue_case / set_fatigue_factors (PHY-07 FR-FAT-06..13). */

import type { FatigueCase } from '@core/model/durability';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { applyFactors, caseProblem, DEFAULT_FACTORS, factorsSchema, factorsShape } from './caseInput';
import { refuseFatigue } from './codes';
import { meanStressSchema, MEAN_STRESS_TEXT, notchSchema, NOTCH_TEXT } from './schemas';
import { fatigueCaseOf, withFatigueCase, withoutFatigueCase } from './store';

const mappingSchema = z
  .array(
    z.object({
      loadCase: z.string().optional().describe('FE load case name this history drives (FE input; not used by history-only cases).'),
      historyId: z.string().describe('History id (affected[0] of define_load_history).'),
      scale: z.number().describe('Multiplier on the history values (history-only: stress = scale x value; FE: scale x load-case stress).'),
    }),
  )
  .describe(
    'Histories driving the case. History-only: stress-kind histories whose scaled series are summed (same length). FE: one load_factor history per load case ' +
      '(loadCase; may be omitted when the analysis has one load case), superposed per node. Needs >= 1 entry.',
  );

const materialSchema = z.object({
  recordId: z.string().describe('Material record id holding the curve.'),
  modelId: z.string().describe('S-N model id (stress_life) or en_coffin_manson model id (strain_life).'),
  cyclicModelId: z.string().optional().describe('strain_life: id of the cyclic_ramberg_osgood model.'),
});

const countingSchema = z.object({
  method: z.enum(['rainflow_3pt', 'rainflow_4pt', 'rainflow_repeating']).describe('Rainflow variant (E1049).'),
  residue: z
    .enum(['half_cycles', 'repeat'])
    .describe('half_cycles: residue counted as half cycles; repeat: close the history as a repeating block.'),
  gate: z.number().optional().describe('Optional hysteresis gate (>= 0) in history units.'),
});

const requiredLifeSchema = z.object({
  value: z.number().describe('Required life, > 0.'),
  unit: z.enum(['cycles', 'blocks', 'flights', 'hours']).describe('Unit of the required life; flights / hours need blocksPerUnit.'),
  blocksPerUnit: z.number().optional().describe('Blocks of the history per flight or hour (flights / hours only).'),
});

const measureSchema = z.union([
  z.enum(['signed_von_mises', 'max_principal']),
  z.object({ component: z.enum(['sxx', 'syy', 'szz', 'sxy', 'syz', 'szx']).describe('Stress component.') }),
]);

const caseShape = {
  method: z
    .enum(['stress_life', 'strain_life'])
    .describe('stress_life (S-N, Miner) or strain_life (epsilon-N with Neuber on nominal stress histories).'),
  analysisId: z
    .string()
    .optional()
    .describe(
      'FE analysis whose STRESS results drive the case. After fea_solve, run the fatigue_field transport (llull-compute, every node) so compute_fatigue can rank the hot spots; without it compute_fatigue refuses with FAT_RESULTS_MISSING.',
    ),
  mapping: mappingSchema,
  measure: measureSchema.optional().describe('FE stress measure (default signed_von_mises).'),
  locations: z
    .object({ mode: z.literal('hotspots').describe('hotspots'), count: z.number().describe('Number of hot spots (>= 1).') })
    .optional()
    .describe('FE locations (default 3 hot spots).'),
  material: materialSchema.describe('Curve to use: material record + model ids.'),
  meanStress: meanStressSchema.optional().describe(`${MEAN_STRESS_TEXT} Default none.`),
  notch: notchSchema.optional().describe(NOTCH_TEXT),
  counting: countingSchema.optional().describe('Counting rule (default rainflow_3pt, half_cycles).'),
  requiredLife: requiredLifeSchema.describe('Life the part must reach.'),
  factors: factorsSchema.optional().describe('Initial factors (see set_fatigue_factors).'),
};

type CaseParams = z.output<z.ZodObject<typeof caseShape>>;

function buildCase(id: string, name: string, params: CaseParams, base: FatigueCase | null): FatigueCase | string {
  const factors = applyFactors(base?.factors ?? DEFAULT_FACTORS, params.factors ?? {});
  if (typeof factors === 'string') return factors;
  return {
    id,
    name,
    method: params.method,
    ...(params.analysisId !== undefined ? { analysisId: params.analysisId } : {}),
    mapping: params.mapping,
    measure: params.measure ?? 'signed_von_mises',
    locations: params.locations ?? { mode: 'hotspots', count: 3 },
    material: params.material,
    meanStress: params.meanStress ?? 'none',
    ...(params.notch !== undefined ? { notch: params.notch } : {}),
    counting: params.counting ?? { method: 'rainflow_3pt', residue: 'half_cycles' },
    requiredLife: params.requiredLife,
    factors,
  };
}

/**
 * @affects doc.analysis.durability.fatigueCases (adds 1 case; affected: [caseId])
 * @invariant ids `fc-<step>.<k>`; defaults named in the summary: damageLimit 1 (Palmgren-Miner), compressiveMean no_benefit, NO scatter factor
 * @failure unknown history / analysis / curve, bad required life or notch -> FAT_HISTORY_NOT_FOUND / FAT_CASE_INVALID / FAT_CURVE_MISSING / FAT_CURVE_UNSUPPORTED; bad factor -> FAT_FACTOR_INVALID (unchanged doc)
 */
export const createFatigueCase = defineCommand({
  name: 'create_fatigue_case',
  description:
    'Create a fatigue (crack-initiation) case: load histories + a material curve + a mean-stress model + required life. History-only: map stress-kind ' +
    'histories (stress = scale x value) and omit analysisId. The curve is an S-N model (stress_life: sn_basquin, sn_power_law, sn_table) or an en_coffin_manson model with a ' +
    'cyclic_ramberg_osgood model (strain_life), both added with add_material_model. Returns the case id in affected[0]. There is NO default scatter factor: next ' +
    'set_fatigue_factors scatter={value, source}, then compute_fatigue and check_fatigue.',
  params: z.object({ name: z.string().min(1).describe('Display name of the case.'), ...caseShape }),
  run: (doc, params): CommandResult => {
    const id = nextId('fc');
    const built = buildCase(id, params.name, params, null);
    if (typeof built === 'string') return refuseFatigue(doc, 'create_fatigue_case', 'FAT_FACTOR_INVALID', built, [], ['factors']);
    const problem = caseProblem(doc, built);
    if (problem !== null) return refuseFatigue(doc, 'create_fatigue_case', problem.code, problem.message, [], [problem.path]);
    return changed(
      withFatigueCase(doc, built),
      `Created fatigue case ${id} '${params.name}' (${built.method}, ${built.mapping.length} history(ies), mean stress ${typeof built.meanStress === 'string' ? built.meanStress : `walker ${built.meanStress.walker}`}); defaults: damageLimit 1 (Palmgren-Miner), compressiveMean no_benefit; scatter factor NOT set - next set_fatigue_factors.`,
      [id],
    );
  },
});

/**
 * @affects doc.analysis.durability.fatigueCases[caseId] (replaces the given fields; factors are kept unless `factors` is given)
 * @failure unknown case -> FAT_CASE_NOT_FOUND; invalid merged case -> as create_fatigue_case (unchanged doc)
 */
export const updateFatigueCase = defineCommand({
  name: 'update_fatigue_case',
  description:
    'Change a fatigue case: any field of create_fatigue_case (omitted fields keep their value; `factors` merges like set_fatigue_factors). The merged case is validated like a new one.',
  params: z.object({
    caseId: z.string().describe('Fatigue case id (affected[0] of create_fatigue_case).'),
    name: z.string().min(1).optional().describe('New display name.'),
    method: caseShape.method.optional(),
    analysisId: caseShape.analysisId.optional(),
    mapping: caseShape.mapping.optional(),
    measure: caseShape.measure.optional(),
    locations: caseShape.locations.optional(),
    material: caseShape.material.optional(),
    meanStress: caseShape.meanStress.optional(),
    notch: caseShape.notch.optional(),
    counting: caseShape.counting.optional(),
    requiredLife: caseShape.requiredLife.optional(),
    factors: caseShape.factors.optional(),
  }),
  run: (doc, params): CommandResult => {
    const current = fatigueCaseOf(doc, params.caseId);
    if (current === undefined)
      return refuseFatigue(
        doc,
        'update_fatigue_case',
        'FAT_CASE_NOT_FOUND',
        `no fatigue case '${params.caseId}'`,
        [params.caseId],
        ['caseId'],
      );
    const merged: CaseParams = {
      method: params.method ?? current.method,
      ...(params.analysisId !== undefined
        ? { analysisId: params.analysisId }
        : current.analysisId !== undefined
          ? { analysisId: current.analysisId }
          : {}),
      mapping: params.mapping ?? [...current.mapping],
      measure: params.measure ?? current.measure,
      locations: params.locations ?? current.locations,
      material: params.material ?? current.material,
      meanStress: params.meanStress ?? current.meanStress,
      ...(params.notch !== undefined ? { notch: params.notch } : current.notch !== undefined ? { notch: current.notch } : {}),
      counting: params.counting ?? current.counting,
      requiredLife: params.requiredLife ?? current.requiredLife,
      ...(params.factors !== undefined ? { factors: params.factors } : {}),
    };
    const built = buildCase(current.id, params.name ?? current.name, merged, current);
    if (typeof built === 'string')
      return refuseFatigue(doc, 'update_fatigue_case', 'FAT_FACTOR_INVALID', built, [params.caseId], ['factors']);
    const problem = caseProblem(doc, built);
    if (problem !== null) return refuseFatigue(doc, 'update_fatigue_case', problem.code, problem.message, [params.caseId], [problem.path]);
    return changed(withFatigueCase(doc, built), `Updated fatigue case ${built.id} '${built.name}'.`, [built.id]);
  },
});

/**
 * @affects doc.analysis.durability.fatigueCases (removes 1 case)
 * @failure unknown id -> FAT_CASE_NOT_FOUND (unchanged doc)
 */
export const deleteFatigueCase = defineCommand({
  name: 'delete_fatigue_case',
  description: 'Delete a fatigue case (its histories and curves stay).',
  annotations: { destructive: true },
  params: z.object({ caseId: z.string().describe('Fatigue case id.') }),
  run: (doc, params): CommandResult => {
    if (fatigueCaseOf(doc, params.caseId) === undefined)
      return refuseFatigue(
        doc,
        'delete_fatigue_case',
        'FAT_CASE_NOT_FOUND',
        `no fatigue case '${params.caseId}'`,
        [params.caseId],
        ['caseId'],
      );
    return changed(withoutFatigueCase(doc, params.caseId), `Deleted fatigue case ${params.caseId}.`, [params.caseId]);
  },
});

/**
 * @affects doc.analysis.durability.fatigueCases[caseId].factors (merges the given fields)
 * @invariant scatter >= 1 with a source; modifiers replace the list and need value > 0 + justification; damageLimit > 0; nothing is defaulted silently
 * @failure unknown case -> FAT_CASE_NOT_FOUND; invalid factor -> FAT_FACTOR_INVALID (unchanged doc)
 */
export const setFatigueFactors = defineCommand({
  name: 'set_fatigue_factors',
  description:
    'Set the named factors of a fatigue case: scatter {value >= 1, source} (NO default: ask the owner), Miner damageLimit (default 1), marginalBand, ' +
    'Marin modifiers (surface / size / reliability / environment / other: value > 0 multiplying the curve strength, each with a justification; REPLACES the list) and ' +
    'compressiveMean (no_benefit | formula). Fields you omit keep their value.',
  params: z.object({ caseId: z.string().describe('Fatigue case id.'), ...factorsShape }),
  run: (doc, params): CommandResult => {
    const current = fatigueCaseOf(doc, params.caseId);
    if (current === undefined)
      return refuseFatigue(
        doc,
        'set_fatigue_factors',
        'FAT_CASE_NOT_FOUND',
        `no fatigue case '${params.caseId}'`,
        [params.caseId],
        ['caseId'],
      );
    const factors = applyFactors(current.factors, params);
    if (typeof factors === 'string')
      return refuseFatigue(doc, 'set_fatigue_factors', 'FAT_FACTOR_INVALID', factors, [params.caseId], ['factors']);
    const scatter = factors.scatter === undefined ? 'scatter NOT set' : `scatter ${factors.scatter.value} (${factors.scatter.source})`;
    return changed(
      withFatigueCase(doc, { ...current, factors }),
      `Set factors of ${current.id}: ${scatter}, damageLimit ${factors.damageLimit}, ${factors.modifiers.length} modifier(s), compressiveMean ${factors.compressiveMean}.`,
      [current.id],
    );
  },
});
