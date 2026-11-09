/** morris_screening (PHY-18 M4): cheap factor screening before sensitivity_indices. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { item, REVIEW_NOTE } from '../fatigue/items';
import { refuseReliability } from './codes';
import { fromStandardNormal } from './distributions';
import { reliabilityOf } from './model';
import { elementaryEffects } from './morris';
import { normalInv } from './numerics';
import { MAX_RESPONSE_EVALUATIONS } from './responseEval';
import { sensitivityTarget } from './sensitivityTarget';

const MAX_EXPRESSION_EVALUATIONS = 2_000_000;
const DEFAULT_TRAJECTORIES = 20;
const DEFAULT_LEVELS = 4;
/** Default tail probability: the unit-cube end points map to the quantiles EDGE and 1 - EDGE (unbounded marginals have no finite 0 / 1 quantile); 1e-6 is +-4.75 sigma of a normal. */
const DEFAULT_EDGE = 1e-6;

/**
 * @affects nothing; read-only, data { variables [{ name, unit, mu, muStar, sigma }], ranking, trajectories, levels, evaluations, items, reviewRequired }
 * @invariant deterministic for (model, trajectories, levels, seed); trajectories (d + 1) evaluations; effects are per unit of the probability coordinate q in [0, 1] of each variable
 * @failure neither / both of response and limitState, unknown name, correlated inputs, non-finite evaluations, budget -> PRB_* refusal (unchanged doc)
 */
export const morrisScreening = defineCommand({
  name: 'morris_screening',
  annotations: { readOnly: true },
  description:
    'Morris elementary-effects screening: ranks the random variables by influence on ONE output (a limit state g via `limitState`, or a defined response via `response`) with only trajectories x (d + 1) evaluations ' +
    '(far cheaper than sensitivity_indices, which costs N (d + 2) with N in the thousands). Each variable moves over a `levels`-point grid of its probability range q in [0, 1] (x = F^-1(q) of its distribution); ' +
    'per variable: mu (mean elementary effect, sign kept), muStar (mean absolute effect: overall influence, the screening measure), sigma (standard deviation: non-linearity or interaction). ' +
    'Effects are output change per unit of q (the full probability range). Needs an integer `seed`; deterministic. Inputs must be independent. Use it to drop variables with a small muStar before sensitivity_indices. ' +
    REVIEW_NOTE,
  params: z.object({
    limitState: z.string().optional().describe('Name of a limit state (define_limit_state). Exactly one of limitState / response.'),
    response: z
      .string()
      .optional()
      .describe('Name of a response (define_response); its inputs are the random variables bound to document parameters.'),
    trajectories: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe(`Number of random trajectories r (default ${DEFAULT_TRAJECTORIES}); 10 to 50 is usual.`),
    levels: z.number().int().min(4).max(20).optional().describe(`Even number of grid levels p (default ${DEFAULT_LEVELS}).`),
    tailProbability: z
      .number()
      .gt(0)
      .lt(0.25)
      .optional()
      .describe(
        `Probability range of each variable: q in [0, 1] maps to the quantiles [tailProbability, 1 - tailProbability] (default ${DEFAULT_EDGE} = +-4.75 sigma of a normal; use 0.001 for +-3.09 sigma when the extreme tails are not of interest). Effects are per unit of q.`,
      ),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .describe('Integer seed in [0, 4294967295] of the PRNG (xoshiro128**).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], paths: string[]): CommandResult =>
      refuseReliability(doc, 'morris_screening', code, message, [...ids], paths);
    if ((params.limitState === undefined) === (params.response === undefined))
      return fail('PRB_PARAMS_INVALID', 'give exactly one of limitState and response', [], ['limitState', 'response']);
    const levels = params.levels ?? DEFAULT_LEVELS;
    if (levels % 2 !== 0) return fail('PRB_PARAMS_INVALID', `levels must be even, got ${levels}`, [], ['levels']);
    const target = sensitivityTarget(doc, params, ctx);
    if ('code' in target)
      return fail(target.code, target.message, target.ids, [params.limitState === undefined ? 'response' : 'limitState']);
    const trajectories = params.trajectories ?? DEFAULT_TRAJECTORIES;
    const d = target.variables.length;
    const evaluations = trajectories * (d + 1);
    const cap = target.usesResponses ? MAX_RESPONSE_EVALUATIONS : MAX_EXPRESSION_EVALUATIONS;
    if (evaluations > cap)
      return fail(
        'PRB_BUDGET_EXCEEDED',
        `${trajectories} trajectories x (${d} + 1) = ${evaluations} evaluations exceed the cap of ${cap}`,
        [],
        ['trajectories'],
      );
    const names = target.variables.map((v) => v.name);
    const correlated = reliabilityOf(doc).correlation?.names.filter((name) => names.includes(name)) ?? [];
    if (correlated.length >= 2)
      return fail('PRB_SOBOL_CORRELATED', `variables ${correlated.join(', ')} are correlated`, correlated, ['limitState']);
    const edge = params.tailProbability ?? DEFAULT_EDGE;
    let failed = 0;
    const f = (q: readonly number[]): number => {
      const x = target.variables.map((variable, i) =>
        fromStandardNormal(variable.distribution, normalInv(edge + (1 - 2 * edge) * (q[i] ?? 0))),
      );
      const value = target.evaluate(x);
      if (!Number.isFinite(value)) failed += 1;
      return value;
    };
    const result = elementaryEffects(f, d, trajectories, levels, params.seed);
    if (failed > 0)
      return fail(
        'PRB_RESPONSE_FAILED',
        `${failed} of ${result.evaluations} evaluations of '${target.label}' were not finite numbers`,
        [target.label],
        [],
      );
    const variables = target.variables.map((variable, i) => ({
      name: variable.name,
      unit: variable.unit,
      mu: result.effects[i]?.mu ?? Number.NaN,
      muStar: result.effects[i]?.muStar ?? Number.NaN,
      sigma: result.effects[i]?.sigma ?? Number.NaN,
    }));
    const ranking = [...variables].sort((a, b) => b.muStar - a.muStar).map((v) => v.name);
    const idle = variables.filter((v) => v.muStar === 0).map((v) => v.name);
    const items = [
      ...target.items,
      ...(idle.length === 0
        ? []
        : [item('PRB_NO_INFLUENCE', 'info', `no effect seen for ${idle.join(', ')}`, 'drop them or raise trajectories', idle)]),
    ];
    return report(
      doc,
      `morris_screening of '${target.label}' (r = ${trajectories}, p = ${levels}, ${result.evaluations} evaluations, seed ${params.seed}): ranking by mu*: ${ranking.join(' > ')}. ${REVIEW_NOTE}`,
      {
        target: { kind: params.limitState === undefined ? 'response' : 'limitState', name: target.label },
        unit: target.unit,
        method: 'Morris 1991 elementary effects, Campolongo 2007 mu*',
        trajectories,
        levels,
        tailProbability: edge,
        delta: result.delta,
        seed: { value: params.seed, source: 'caller', defaulted: false },
        prng: 'xoshiro128**',
        evaluations: result.evaluations,
        variables,
        ranking,
        items,
        unverified: target.unverifiedReasons.length > 0,
        unverifiedReasons: target.unverifiedReasons,
        reviewRequired: true,
      },
    );
  },
});
