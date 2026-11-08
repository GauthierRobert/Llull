/** compare_materials (PHY-12 FR-SEL-03, 04, 05, 10, 12): ranking by weighted performance indices under constraints, with the Pareto set. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { basesOf, mixedBasesWarning, unverifiedSummary } from './bases';
import { issue, REVIEW_SENTENCE, refuseSel } from './codes';
import { constraintProblem, evaluateConstraint, type ConstraintFailure } from './constraints';
import { evaluateIndex, isExcluded } from './indices';
import { ruleOf } from './indexRules';
import {
  directionSchema,
  optionsProblem,
  quantitySchema,
  resolveOptionsOf,
  strengthSchema,
  temperatureSchema,
  thicknessSchema,
  unique,
  unknownMaterials,
} from './inputs';
import { normaliseWeights, paretoSet, rankScored } from './rank';
import { INDEX_CASES, type Excluded, type IndexResult, type SelIssue } from './types';

const COMMAND = 'compare_materials';

/** Material ids of the request: the listed ones, or every material imported from a library (null when the library is not in the document). */
function candidatesOf(doc: CadDocument, materials: string[] | { readonly library: string }): string[] | null {
  if (Array.isArray(materials)) return unique(materials);
  const { library } = materials;
  if (!Object.hasOwn(doc.materialLibraries ?? {}, library)) return null;
  return Object.values(doc.materials)
    .filter((material) => material.record?.libraryRef?.libraryId === library)
    .map((material) => material.name)
    .sort();
}

const objectiveSchema = z.object({
  index: z.enum(INDEX_CASES).describe('Loading case whose index P^n / rho is maximised (see material_index for the cases).'),
  weight: z
    .number()
    .optional()
    .describe(
      'Weight of this objective, >= 0. Give a weight to every objective or to none (equal weights, reported as defaulted). Normalised to sum 1.',
    ),
  strengthProperty: strengthSchema.optional(),
});

const constraintSchema = z.object({
  property: z.string().describe('Catalogue property constrained: density, E, G, nu, Ftu, Fty, Fcy, Fsu, cte, k, cp ...'),
  min: quantitySchema('Lower bound')
    .optional()
    .describe('Minimum accepted value { value, unit }; the unit also fixes the unit of the comparison.'),
  max: quantitySchema('Upper bound').optional().describe('Maximum accepted value { value, unit }.'),
  direction: directionSchema.optional(),
});

/**
 * @affects nothing - read-only; data { ranked[], failed[], excluded[], pareto?, weights, objectives[], basesUsed[], warnings[], unverified, reviewRequired }
 * @invariant score_i = sum_k w_k I_k,i / max_j I_k,j over the candidates that passed; descending score, ties by ascending id; a candidate missing a required
 *   value is excluded (never ranked on a guess, never a pass or a fail); the Pareto set minimises 1 / I_k, ascending ids; request order never changes the result
 * @failure no objective SEL_NO_OBJECTIVE, weight < 0 / all 0 / partly given SEL_WEIGHT_INVALID, unknown material or library SEL_MATERIAL_NOT_FOUND, strength index without
 *   strengthProperty SEL_STRENGTH_PROPERTY_UNSET, bad constraint / unit SEL_PARAMS_INVALID (refusals); every candidate failed or excluded -> empty ranked + SEL_NO_CANDIDATE warning
 */
export const compareMaterials = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'Rank materials of the document for a loading case: each objective is a performance index P^n / rho (material_index lists them: tie, beam, panel, column_buckling; stiffness or strength), ' +
    'higher is better. Candidates are first filtered by constraints (min / max on any property with its unit, e.g. Fty >= 400 MPa); then score = sum of weight x index / best index of the survivors, ' +
    'so the best candidate of a single objective scores 1. Weights are given for every objective or none (equal weights, data.weights.defaulted true). ' +
    'A candidate without a required value (density, E, a strength, a constrained property) is listed in data.excluded with SEL_PROPERTY_MISSING and the missing names: it is never ranked ' +
    'on a guess, and never counted as passing or failing. data.failed lists the failing constraint with its value. pareto: true adds data.pareto, the non-dominated candidates ' +
    'when every objective is minimised as relative mass 1/index (ascending ids). Strength indices need their own strengthProperty (Fty, Ftu, Fcy). Returns data { ranked: [{ material, rank, score, objectives }], failed, excluded, ' +
    'pareto?, weights: { value, defaulted, source? }, basesUsed, warnings, unverified, reviewRequired }. Typical / supplier values make the ranking unverified; mixed bases give SEL_BASIS_MIXED; an empty ranking is not an error ' +
    '(warning SEL_NO_CANDIDATE). Read-only. Apply a choice with assign_material (after a human decision; substitute_material shows the effect on a part first).',
  params: z.object({
    materials: z
      .union([
        z.array(z.string()),
        z.object({ library: z.string().describe('Library id: every material imported from it is a candidate.') }),
      ])
      .describe(
        'Candidate material ids of the document, or { library } for every record imported from one library (import_material_library).',
      ),
    objectives: z
      .array(objectiveSchema)
      .describe(
        'One or more objectives, e.g. [{ index: "beam_stiffness", weight: 0.7 }, { index: "beam_strength", strengthProperty: "Fty", weight: 0.3 }].',
      ),
    constraints: z.array(constraintSchema).optional().describe('Constraints every candidate must meet (all of them).'),
    pareto: z.boolean().optional().describe('true: also return the Pareto set (non-dominated candidates). Default false.'),
    direction: directionSchema.optional(),
    thickness: thicknessSchema.optional(),
    temperature: temperatureSchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const { objectives, constraints } = params;
    if (objectives.length === 0) return refuseSel(doc, COMMAND, 'SEL_NO_OBJECTIVE', 'no objective given', [], ['objectives']);
    const weights = normaliseWeights(objectives.map((objective) => objective.weight));
    if (typeof weights === 'string') {
      const bad = objectives.findIndex((objective) => objective.weight !== undefined && !(objective.weight >= 0));
      return refuseSel(doc, COMMAND, 'SEL_WEIGHT_INVALID', weights, [], [`objectives.${Math.max(bad, 0)}.weight`]);
    }
    const unset = objectives.findIndex(
      (objective) => ruleOf(objective.index)?.property === 'strength' && objective.strengthProperty === undefined,
    );
    if (unset >= 0)
      return refuseSel(
        doc,
        COMMAND,
        'SEL_STRENGTH_PROPERTY_UNSET',
        `objective ${unset} (${objectives[unset]?.index ?? ''}) needs a strength property`,
        [],
        [`objectives.${unset}.strengthProperty`],
      );
    const problem = optionsProblem(params) ?? (constraints ?? []).map(constraintProblem).find((entry) => entry !== null) ?? null;
    if (problem !== null) return refuseSel(doc, COMMAND, 'SEL_PARAMS_INVALID', problem, [], [problem.split(/[:]/)[0] ?? 'params']);
    const candidates = candidatesOf(doc, params.materials);
    if (candidates === null)
      return refuseSel(
        doc,
        COMMAND,
        'SEL_MATERIAL_NOT_FOUND',
        `no material library '${Array.isArray(params.materials) ? '' : params.materials.library}' in the document`,
        [],
        ['materials.library'],
      );
    const unknown = unknownMaterials(doc, candidates);
    if (unknown.length > 0)
      return refuseSel(
        doc,
        COMMAND,
        'SEL_MATERIAL_NOT_FOUND',
        `no material ${unknown.map((id) => `'${id}'`).join(', ')}`,
        unknown,
        ['materials'],
        { known: Object.keys(doc.materials) },
      );
    const options = resolveOptionsOf(params);
    const excluded: Excluded[] = [];
    const failed: ConstraintFailure[] = [];
    const survivors: { readonly item: readonly IndexResult[]; readonly id: string; readonly values: readonly number[] }[] = [];
    const constraintInputs: { readonly input: IndexResult['inputs'][number] }[] = [];
    for (const material of candidates) {
      const evaluated = objectives.map((objective) => {
        const rule = ruleOf(objective.index);
        return rule === undefined
          ? undefined
          : evaluateIndex(doc, material, rule, { ...options, strengthProperty: objective.strengthProperty });
      });
      const missingIndex = evaluated.find((entry): entry is Excluded => entry !== undefined && isExcluded(entry));
      const outcomes = (constraints ?? []).map((constraint) => evaluateConstraint(doc, material, constraint, options));
      const missingConstraint = outcomes.find((outcome) => outcome.kind === 'missing');
      if (missingIndex !== undefined || missingConstraint?.kind === 'missing') {
        const reasons = [
          ...evaluated.flatMap((entry) => (entry !== undefined && isExcluded(entry) ? [entry] : [])),
          ...outcomes.flatMap((outcome) => (outcome.kind === 'missing' ? [outcome.excluded] : [])),
        ];
        excluded.push({
          material,
          code: reasons[0]?.code ?? 'SEL_PROPERTY_MISSING',
          reason: unique(reasons.map((entry) => entry.reason)).join('; '),
          missing: unique(reasons.flatMap((entry) => entry.missing ?? [])),
        });
        continue;
      }
      const failures = outcomes.flatMap((outcome) => (outcome.kind === 'fail' ? [outcome.failure] : []));
      if (failures.length > 0) {
        failed.push(...failures);
        continue;
      }
      const results = evaluated.filter((entry): entry is IndexResult => entry !== undefined && !isExcluded(entry));
      constraintInputs.push(...outcomes.flatMap((outcome) => (outcome.kind === 'pass' ? [{ input: outcome.use }] : [])));
      survivors.push({ item: results, id: material, values: results.map((result) => result.value) });
    }
    const ranked = rankScored(survivors, weights.value).map((entry) => ({
      material: entry.id,
      rank: entry.rank,
      score: entry.score,
      objectives: entry.item,
    }));
    const pareto =
      params.pareto === true
        ? paretoSet(survivors.map((entry) => ({ id: entry.id, values: entry.values.map((value) => 1 / value) })))
        : undefined;
    const rankedInputs = ranked.flatMap((entry) => entry.objectives.flatMap((result) => result.inputs));
    const bases = basesOf([...rankedInputs, ...constraintInputs.map((entry) => entry.input)]);
    const warnings: SelIssue[] = [
      ...(ranked.length === 0
        ? [
            issue(
              'SEL_NO_CANDIDATE',
              'warning',
              `${candidates.length} candidate(s): none ranked (${failed.length} failed, ${excluded.length} excluded)`,
              candidates,
            ),
          ]
        : []),
      ...unverifiedSummary(
        ranked.filter((entry) => entry.objectives.some((result) => result.unverified)).map((entry) => entry.material),
        ranked.flatMap((entry) =>
          entry.objectives.flatMap((result) => result.unverifiedReasons.map((reason) => `${entry.material} ${reason}`)),
        ),
      ),
      ...mixedBasesWarning(
        bases,
        ranked.map((entry) => entry.material),
      ),
      ...excluded.map((entry) => issue(entry.code, 'warning', `'${entry.material}' excluded: ${entry.reason}`, [entry.material])),
    ];
    const unverified = ranked.some((entry) => entry.objectives.some((result) => result.unverified));
    const top = ranked[0];
    return report(
      doc,
      `${COMMAND}: ${candidates.length} candidate(s), ${ranked.length} ranked, ${failed.length} failed constraint(s), ${excluded.length} excluded` +
        `${top === undefined ? '' : `; best '${top.material}' (score ${Number(top.score.toPrecision(6))})`}` +
        `${pareto === undefined ? '' : `; Pareto ${pareto.join(', ')}`}${unverified ? '; UNVERIFIED inputs (typical / supplier / legacy values)' : ''}; ${REVIEW_SENTENCE}.`,
      {
        ranked,
        failed,
        excluded,
        ...(pareto !== undefined ? { pareto } : {}),
        weights,
        objectives: objectives.map((objective) => ({
          index: objective.index,
          ...(objective.strengthProperty !== undefined ? { strengthProperty: objective.strengthProperty } : {}),
        })),
        basesUsed: bases,
        warnings,
        unverified,
        reviewRequired: true,
      },
    );
  },
});
