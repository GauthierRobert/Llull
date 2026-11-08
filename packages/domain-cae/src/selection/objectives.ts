/** Objectives of a comparison (PHY-12 FR-SEL-03, 05, 06): a rule-table index or a user-defined one, validated and evaluated in one place. */

import { z } from '@core/commands/schema';
import type { CadDocument } from '@core/model/types';
import { evaluateIndex, type IndexOptions } from './indices';
import { ruleOf } from './indexRules';
import { strengthSchema } from './inputs';
import { INDEX_CASES, type Excluded, type IndexResult } from './types';
import { evaluateUserIndex, userIndexProblem } from './userIndex';

export const objectiveSchema = z.object({
  index: z
    .enum([...INDEX_CASES, 'user'])
    .describe(
      'Loading case whose index P^n / rho is maximised (see material_index for the cases), or "user" for a user-defined index (then exponents and derivationNote are required).',
    ),
  weight: z
    .number()
    .optional()
    .describe(
      'Weight of this objective, >= 0. Give a weight to every objective or to none (equal weights, reported as defaulted). Normalised to sum 1.',
    ),
  strengthProperty: strengthSchema.optional(),
  exponents: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      'index "user" only: exponent a_i of each catalogue property P_i, e.g. { "E": 0.5 }: the index is prod(P_i ^ a_i) / density (E in GPa, strengths in MPa, density in Mg/m^3). Non-zero, density excluded.',
    ),
  derivationNote: z
    .string()
    .optional()
    .describe(
      'index "user" only, REQUIRED: how the index follows from the loading case (stored with the result; a blank note is SEL_DERIVATION_NOTE_MISSING).',
    ),
});

export type Objective = z.output<typeof objectiveSchema>;

/** The first problem of the objectives as a refusal (code, message, param path), or null. */
export function objectiveProblem(
  objectives: readonly Objective[],
): { readonly code: string; readonly message: string; readonly path: string } | null {
  for (const [k, objective] of objectives.entries()) {
    if (objective.index === 'user') {
      const problem = userIndexProblem({ exponents: objective.exponents ?? {}, derivationNote: objective.derivationNote ?? '' });
      if (problem !== null)
        return { ...problem, path: `objectives.${k}.${problem.code === 'SEL_DERIVATION_NOTE_MISSING' ? 'derivationNote' : 'exponents'}` };
    } else if (ruleOf(objective.index)?.property === 'strength' && objective.strengthProperty === undefined) {
      return {
        code: 'SEL_STRENGTH_PROPERTY_UNSET',
        message: `objective ${k} (${objective.index}) needs a strength property`,
        path: `objectives.${k}.strengthProperty`,
      };
    }
  }
  return null;
}

/** One objective of one candidate: the index value, or why the candidate is excluded. */
export function evaluateObjective(doc: CadDocument, material: string, objective: Objective, options: IndexOptions): IndexResult | Excluded {
  if (objective.index === 'user')
    return evaluateUserIndex(
      doc,
      material,
      { exponents: objective.exponents ?? {}, derivationNote: objective.derivationNote ?? '' },
      options,
    );
  const rule = ruleOf(objective.index);
  return rule === undefined
    ? { material, code: 'SEL_PARAMS_INVALID', reason: `unknown index ${objective.index}`, missing: [] }
    : evaluateIndex(doc, material, rule, { ...options, strengthProperty: objective.strengthProperty });
}
