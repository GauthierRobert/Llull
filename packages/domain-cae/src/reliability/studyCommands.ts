/** reliability_form / propagate_uncertainty / run_reliability_study (PHY-18): read-only analyses of the document's probabilistic model. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { REVIEW_NOTE } from '../fatigue/items';
import { refuseReliability } from './codes';
import { isStudyFailure, studyContext, type StudyContext } from './context';
import { reliabilityOf } from './model';
import { formStudy, fosmStudy, monteCarloStudy } from './studies';

const MAX_SAMPLES = 2_000_000;
const DEFAULT_SAMPLES = 10_000;
/** Cap on samples x variables (the sample matrix is held in memory). */
const MAX_SAMPLE_VALUES = 20_000_000;

const seedSchema = z
  .number()
  .int()
  .min(0)
  .max(2 ** 32 - 1)
  .describe(
    'Integer seed in [0, 4294967295] of the PRNG (xoshiro128**); the same model, method, samples and seed give bit-identical results.',
  );
const iterationsSchema = z.number().int().min(1).max(1000).optional().describe('Maximum HL-RF iterations (default 100).');
const toleranceSchema = z
  .number()
  .positive()
  .optional()
  .describe('FORM stops when no u component changes by more than this (default 1e-8).');

/** Why the total sampling work (samples x limit states, samples x variables) is over budget, or null. */
const budgetIssue = (samples: number, limitStates: number, variables: number): string | null =>
  samples * limitStates > MAX_SAMPLES
    ? `${samples} samples x ${limitStates} limit state(s) exceed the total cap of ${MAX_SAMPLES} evaluations`
    : samples * Math.max(variables, 1) > MAX_SAMPLE_VALUES
      ? `${samples} samples x ${variables} variable(s) exceed the memory cap of ${MAX_SAMPLE_VALUES} values`
      : null;

const withContext = (
  doc: CadDocument,
  command: string,
  limitState: string,
  proceed: (context: StudyContext) => CommandResult,
): CommandResult => {
  const context = studyContext(doc, limitState);
  return isStudyFailure(context) ? refuseReliability(doc, command, context.code, context.message, context.ids, []) : proceed(context);
};

/**
 * @affects nothing; read-only, data { beta, pfForm, pfSorm?, curvatures?, designPointU, designPointX{value,unit}, importance (sums to 1), iterations, converged, items, unverified, reviewRequired: true }
 * @invariant exact (beta = (muR - muS) / sqrt(sR^2 + sS^2)) for a linear limit state in normal variables; deterministic
 * @failure unknown limit state / unknown symbol / no random variable / correlation unrealisable -> PRB_* refusal (unchanged doc); no convergence -> data with PRB_FORM_NOT_CONVERGED and the last iterate
 */
export const reliabilityForm = defineCommand({
  name: 'reliability_form',
  annotations: { readOnly: true },
  description:
    'FORM reliability analysis of a limit state g(x) (failure when g < 0): Hasofer-Lind / Rackwitz-Fiessler iteration in standard normal space with a Nataf transform for ' +
    'the distributions and correlation. Returns data { beta, pfForm = Φ(-beta), designPointX { variable: { value, unit } } (most probable failure point), importance { variable: alpha^2 } ' +
    '(sums to 1: which variable drives failure), iterations, converged, items[] }. beta is negative when the origin (all variables at their medians) already fails. ' +
    'With sorm: true also the Breitung correction { curvatures, pfSorm, betaSorm } (needs a converged design point with beta > 0). Exact for linear g in normal variables ' +
    '(R - S: beta = (muR - muS) / sqrt(sR^2 + sS^2)). Gradients by central differences (step 1e-6 in u). Always flagged reviewRequired: Pf is not an approval. ' +
    `${REVIEW_NOTE} Cross-check with run_reliability_study or propagate_uncertainty.`,
  params: z.object({
    limitState: z.string().describe('Name of a limit state (define_limit_state).'),
    sorm: z.boolean().optional().describe('Also compute the SORM (Breitung) failure probability. Default false.'),
    maxIterations: iterationsSchema,
    tolerance: toleranceSchema,
  }),
  run: (doc, params): CommandResult =>
    withContext(doc, 'reliability_form', params.limitState, (context) => {
      const study = formStudy(context, params.sorm ?? false, params.maxIterations ?? 100, params.tolerance ?? 1e-8);
      const sorm = study.pfSorm === null ? '' : `, Pf_SORM = ${study.pfSorm.toPrecision(8)}`;
      return report(
        doc,
        `reliability_form '${params.limitState}': beta = ${study.beta.toPrecision(8)}, Pf_FORM = ${study.pf.toPrecision(8)}${sorm} (${study.converged ? 'converged' : 'NOT converged'}, ${context.variables.length} variable(s)). ${REVIEW_NOTE}`,
        study.data,
      );
    }),
});

/**
 * @affects nothing; read-only, data { method, samples, seed, prng, limitStates { name: Monte Carlo data | FOSM data }, items, reviewRequired: true }
 * @invariant deterministic for (model, method, samples, seed); one sampled study per selected limit state
 * @failure empty model, unknown limit state, samples above 2e6, missing seed for a sampling method -> PRB_* refusal (unchanged doc)
 */
export const propagateUncertainty = defineCommand({
  name: 'propagate_uncertainty',
  annotations: { readOnly: true },
  description:
    'Propagate the scatter of the random variables through the limit states. method "mc" (seeded Monte Carlo), "lhs" (Latin hypercube, default, lower variance) or ' +
    '"lhs_centred" sample `samples` points (default 10000, at most 2000000 in total over all limit states; needs an integer `seed` in [0, 4294967295]) and return for each limit state g: mean, sd, min, max, quantiles, ' +
    'a 20-bin histogram, Pf = P(g < 0) with standard error and Wilson 95 % interval, the equivalent beta, and PRB_PF_BELOW_RESOLUTION when nothing failed. ' +
    'method "fosm" (first-order second-moment, no seed) returns mean, sd, Cornell beta, Pf (g assumed normal) and the share of variance per variable. ' +
    `Correlation set with set_correlation is honoured. Limit states default to all defined ones. ${REVIEW_NOTE}`,
  params: z.object({
    limitState: z.string().optional().describe('Only this limit state; default all limit states of the model.'),
    method: z.enum(['mc', 'lhs', 'lhs_centred', 'fosm']).optional().describe('Sampling method or "fosm". Default "lhs".'),
    samples: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe(`Number of samples (default ${DEFAULT_SAMPLES}, at most ${MAX_SAMPLES}). Ignored by fosm.`),
    seed: seedSchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[]): CommandResult =>
      refuseReliability(doc, 'propagate_uncertainty', code, message, [], paths);
    const model = reliabilityOf(doc);
    const names = params.limitState === undefined ? model.limitStateOrder : [params.limitState];
    if (names.length === 0) return fail('PRB_MODEL_EMPTY', 'the document has no limit state', []);
    const method = params.method ?? 'lhs';
    const samples = params.samples ?? DEFAULT_SAMPLES;
    if (method !== 'fosm') {
      const budget = budgetIssue(samples, names.length, model.variableOrder.length);
      if (budget !== null) return fail('PRB_BUDGET_EXCEEDED', budget, ['samples']);
      if (params.seed === undefined) return fail('PRB_PARAMS_INVALID', `method '${method}' needs an integer seed`, ['seed']);
    }
    const results: Record<string, unknown> = {};
    const lines: string[] = [];
    for (const name of names) {
      const context = studyContext(doc, name);
      if (isStudyFailure(context)) return fail(context.code, context.message, ['limitState']);
      if (method === 'fosm') {
        const fosm = fosmStudy(context);
        results[name] = fosm.data;
        lines.push(
          `${name}: mean ${String(fosm.data['mean'])}, sd ${String(fosm.data['sd'])}, Pf_FOSM ${fosm.pf === null ? 'n/a' : fosm.pf.toPrecision(5)}`,
        );
      } else {
        const study = monteCarloStudy(context, method, samples, params.seed ?? 0);
        results[name] = study.data;
        lines.push(
          `${name}: Pf = ${study.pf.toPrecision(5)} (Wilson 95 % [${study.wilson95[0].toPrecision(4)}, ${study.wilson95[1].toPrecision(4)}])`,
        );
      }
    }
    const data = {
      method,
      ...(method === 'fosm'
        ? {}
        : { samples, seed: { value: params.seed ?? 0, source: 'caller', defaulted: false }, prng: 'xoshiro128**' }),
      limitStates: results,
      reviewRequired: true,
    };
    return report(
      doc,
      `propagate_uncertainty (${method}${method === 'fosm' ? '' : `, N = ${samples}, seed ${params.seed ?? 0}`}): ${lines.join('; ')}. ${REVIEW_NOTE}`,
      data,
    );
  },
});

const METHODS = ['form', 'sorm', 'mc', 'fosm'] as const;

/**
 * @affects nothing; read-only, data { form?, sorm?, monteCarlo?, fosm?, comparison { pf per method, formInsideMonteCarloInterval? }, items, reviewRequired: true }
 * @invariant FORM / SORM / FOSM are deterministic; Monte Carlo is deterministic for its seed; PRB_FORM_MC_DISAGREE when the Pf of the requested FORM (SORM when only SORM is requested) lies outside the Wilson 95 % interval
 * @failure unknown limit state, no random variable, mc without seed, samples above 2e6 -> PRB_* refusal (unchanged doc)
 */
export const runReliabilityStudy = defineCommand({
  name: 'run_reliability_study',
  annotations: { readOnly: true },
  description:
    'Run several reliability methods on ONE limit state and compare them: "form" (Hasofer-Lind / Rackwitz-Fiessler with Nataf), "sorm" (FORM + Breitung curvature correction), ' +
    '"mc" (seeded Monte Carlo or Latin hypercube, needs `seed`) and "fosm" (first-order second-moment). Default methods: form, mc, fosm. Returns data { form, sorm, monteCarlo, fosm, ' +
    'comparison { pf: { method: Pf }, formInsideMonteCarloInterval }, items[], reviewRequired: true } and the item PRB_FORM_MC_DISAGREE when the FORM Pf falls outside the Monte Carlo ' +
    `Wilson 95 % interval (report the Monte Carlo value, consider SORM). Same data shapes as reliability_form and propagate_uncertainty. ${REVIEW_NOTE}`,
  params: z.object({
    limitState: z.string().describe('Name of a limit state (define_limit_state).'),
    methods: z
      .array(z.enum(METHODS))
      .min(1)
      .optional()
      .describe('Methods to run, any of form, sorm, mc, fosm. Default ["form", "mc", "fosm"].'),
    samples: z.number().int().min(2).optional().describe(`Monte Carlo samples (default ${DEFAULT_SAMPLES}, at most ${MAX_SAMPLES}).`),
    seed: seedSchema.optional(),
    sampling: z.enum(['mc', 'lhs', 'lhs_centred']).optional().describe('Sampling scheme of the "mc" method. Default "lhs".'),
    maxIterations: iterationsSchema,
    tolerance: toleranceSchema,
  }),
  run: (doc, params): CommandResult => {
    const methods = new Set(params.methods ?? ['form', 'mc', 'fosm']);
    const samples = params.samples ?? DEFAULT_SAMPLES;
    const precheck = (code: string, message: string, path: string): CommandResult =>
      refuseReliability(doc, 'run_reliability_study', code, message, [params.limitState], [path]);
    if (methods.has('mc') && params.seed === undefined) return precheck('PRB_PARAMS_INVALID', "method 'mc' needs an integer seed", 'seed');
    const budget = methods.has('mc') ? budgetIssue(samples, 1, reliabilityOf(doc).variableOrder.length) : null;
    if (budget !== null) return precheck('PRB_BUDGET_EXCEEDED', budget, 'samples');
    return withContext(doc, 'run_reliability_study', params.limitState, (context) => {
      const pf: Record<string, number | null> = {};
      const items: unknown[] = [];
      const data: Record<string, unknown> = { limitState: params.limitState, unit: context.limitState.unit, reviewRequired: true };
      const iterations = params.maxIterations ?? 100;
      const tolerance = params.tolerance ?? 1e-8;
      let compared: { method: string; value: number | null } | null = null;
      if (methods.has('form') || methods.has('sorm')) {
        const study = formStudy(context, methods.has('sorm'), iterations, tolerance);
        if (methods.has('form')) {
          data['form'] = study.data;
          pf['form'] = study.pf;
        }
        if (methods.has('sorm')) data['sorm'] = study.data;
        if (methods.has('sorm')) pf['sorm'] = study.pfSorm;
        compared = methods.has('form') ? { method: 'FORM', value: study.pf } : { method: 'SORM', value: study.pfSorm };
      }
      let interval: [number, number] | null = null;
      if (methods.has('mc')) {
        const study = monteCarloStudy(context, params.sampling ?? 'lhs', samples, params.seed ?? 0);
        data['monteCarlo'] = study.data;
        pf['mc'] = study.pf;
        interval = study.wilson95;
      }
      if (methods.has('fosm')) {
        const study = fosmStudy(context);
        data['fosm'] = study.data;
        pf['fosm'] = study.pf;
      }
      const comparedPf = compared?.value ?? null;
      const inside = comparedPf !== null && interval !== null ? comparedPf >= interval[0] && comparedPf <= interval[1] : null;
      if (inside === false)
        items.push({
          code: 'PRB_FORM_MC_DISAGREE',
          severity: 'warning',
          ids: [params.limitState],
          message: `${compared?.method} Pf ${comparedPf} is outside the Monte Carlo Wilson 95 % interval [${interval?.[0]}, ${interval?.[1]}]`,
          remediation: compared?.method === 'SORM' ? 'report the Monte Carlo value' : 'report the Monte Carlo value; consider SORM',
        });
      data['comparison'] = { pf, formInsideMonteCarloInterval: inside };
      data['items'] = items;
      const shown = Object.entries(pf).map(([method, value]) => `${method} ${value === null ? 'n/a' : value.toPrecision(6)}`);
      return report(
        doc,
        `run_reliability_study '${params.limitState}': Pf by method — ${shown.join(', ')}${inside === false ? ' (PRB_FORM_MC_DISAGREE)' : ''}. ${REVIEW_NOTE}`,
        data,
      );
    });
  },
});
