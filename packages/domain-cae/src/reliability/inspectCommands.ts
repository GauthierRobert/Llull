/** describe_probabilistic_model / check_probabilistic (PHY-18): read-only inspection and the AF-20 check of the probabilistic model. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { item, REVIEW_NOTE, statusOfItems, type Item } from '../fatigue/items';
import { verifyAcceptance } from './acceptance';
import { refuseReliability } from './codes';
import { isStudyFailure, studyContext } from './context';
import { momentsOf } from './distributions';
import { limitStateModelHash } from './modelHash';
import { reliabilityOf } from './model';
import { MAX_RESPONSE_EVALUATIONS } from './responseEval';
import { formStudy, monteCarloStudy } from './studies';

const DEFAULT_MC_COV_LIMIT = 0.1;
const DEFAULT_SAMPLES = 10_000;

/**
 * @affects nothing; read-only, data { variables, correlation, responses, limitStates (each with modelHash and acceptance), unverified, reviewRequired: true }
 * @invariant resolved distributions with mean / sd; a limit state's modelHash is the one accept_reliability_result needs
 * @failure none (an empty model is described as empty)
 */
export const describeProbabilisticModel = defineCommand({
  name: 'describe_probabilistic_model',
  annotations: { readOnly: true },
  description:
    'Describe the probabilistic model of the document: every random variable with its resolved distribution (mean, sd, unit, binding, citation, unverified when the scatter has no citation), the correlation, ' +
    'the responses (define_response), and every limit state with its expression, unit, targets, `modelHash` (what accept_reliability_result binds to) and whether it carries a signed acceptance. ' +
    `Run it before a study to see what is defined. ${REVIEW_NOTE}`,
  params: z.object({}),
  run: (doc): CommandResult => {
    const model = reliabilityOf(doc);
    const variables = model.variableOrder.flatMap((name) => {
      const variable = model.variables[name];
      if (variable === undefined) return [];
      const { mean, sd } = momentsOf(variable.distribution);
      return [
        {
          name,
          unit: variable.unit,
          distribution: variable.distribution,
          mean,
          sd,
          binding: variable.binding,
          ...(variable.citation === undefined ? {} : { citation: variable.citation }),
          unverified: variable.citation === undefined,
        },
      ];
    });
    const responses = (model.responseOrder ?? []).flatMap((name) => {
      const response = model.responses?.[name];
      return response === undefined ? [] : [{ name, unit: response.unit, query: response.query }];
    });
    const limitStates = model.limitStateOrder.flatMap((name) => {
      const limitState = model.limitStates[name];
      if (limitState === undefined) return [];
      const accepted = model.acceptances?.[name];
      return [
        {
          name,
          expression: limitState.expression,
          unit: limitState.unit,
          ...(limitState.targetBeta === undefined ? {} : { targetBeta: limitState.targetBeta }),
          ...(limitState.targetPf === undefined ? {} : { targetPf: limitState.targetPf }),
          modelHash: limitStateModelHash(doc, name),
          acceptance:
            accepted === undefined ? null : { signer: accepted.signer, signatureId: accepted.signatureId, modelHash: accepted.modelHash },
        },
      ];
    });
    const unverified = variables.filter((v) => v.unverified).map((v) => v.name);
    return report(
      doc,
      `Probabilistic model: ${variables.length} random variable(s), ${responses.length} response(s), ${limitStates.length} limit state(s)` +
        `${unverified.length === 0 ? '' : `; unsourced scatter: ${unverified.join(', ')}`}. ${REVIEW_NOTE}`,
      { variables, correlation: model.correlation ?? null, responses, limitStates, unverified, reviewRequired: true },
    );
  },
});

/**
 * @affects nothing; read-only, data { status, items, limitStates { name: { beta, pfForm, accepted } }, reviewRequired: true }
 * @invariant FORM always (deterministic); Monte Carlo only with a seed; acceptances are re-verified through the signing port (PRB_RESULT_STALE when the model changed)
 * @failure unknown limit state / no limit state -> PRB_LIMIT_STATE_NOT_FOUND / PRB_MODEL_EMPTY refusal (unchanged doc); a limit state that cannot be studied is an error item
 */
export const checkProbabilistic = defineCommand({
  name: 'check_probabilistic',
  annotations: { readOnly: true },
  description:
    'Check the probabilistic model (AF-20): per limit state it runs FORM and reports items with stable codes: PRB_SCATTER_UNSOURCED (variable without citation), PRB_TARGET_UNSET / PRB_TARGET_NOT_MET (beta / Pf against the owner target), ' +
    'PRB_FORM_NOT_CONVERGED, and, when `seed` is given, a Latin hypercube Monte Carlo with PRB_MC_NOT_CONVERGED (coefficient of variation of Pf above `mcPfCovLimit`, default 0.1) and PRB_PF_BELOW_RESOLUTION. ' +
    'A signed acceptance (accept_reliability_result) is re-verified: PRB_RESULT_STALE when the model changed since, PRB_HUMAN_GATE when the signature no longer verifies. ' +
    `status is fail / warn / pass over the items; reviewRequired is always true. ${REVIEW_NOTE}`,
  params: z.object({
    limitState: z.string().optional().describe('Only this limit state; default all.'),
    mcPfCovLimit: z
      .number()
      .positive()
      .optional()
      .describe(`Largest acceptable coefficient of variation of the Monte Carlo Pf (default ${DEFAULT_MC_COV_LIMIT}).`),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .optional()
      .describe('Integer seed: also run a Monte Carlo of `samples` points. Omit to skip it.'),
    samples: z
      .number()
      .int()
      .min(2)
      .max(2_000_000)
      .optional()
      .describe(`Monte Carlo samples when a seed is given (default ${DEFAULT_SAMPLES}).`),
  }),
  run: (doc, params, ctx): CommandResult => {
    const model = reliabilityOf(doc);
    const names = params.limitState === undefined ? model.limitStateOrder : [params.limitState];
    if (params.limitState !== undefined && model.limitStates[params.limitState] === undefined)
      return refuseReliability(
        doc,
        'check_probabilistic',
        'PRB_LIMIT_STATE_NOT_FOUND',
        `no limit state '${params.limitState}'`,
        [params.limitState],
        ['limitState'],
      );
    if (names.length === 0)
      return refuseReliability(doc, 'check_probabilistic', 'PRB_MODEL_EMPTY', 'the document has no limit state', [], []);
    const covLimit = params.mcPfCovLimit ?? DEFAULT_MC_COV_LIMIT;
    const samples = params.samples ?? DEFAULT_SAMPLES;
    const items: Item[] = [];
    const summaries: Record<string, unknown> = {};
    for (const name of names) {
      const context = studyContext(doc, name, ctx);
      if (isStudyFailure(context)) {
        items.push(item(context.code, 'error', context.message, 'fix the limit state or its variables', context.ids));
        continue;
      }
      const form = formStudy(context, false, 100, 1e-8);
      items.push(...((form.data['items'] as Item[] | undefined) ?? []));
      if (params.seed !== undefined) {
        if (context.usesResponses && samples > MAX_RESPONSE_EVALUATIONS)
          items.push(
            item(
              'PRB_BUDGET_EXCEEDED',
              'error',
              `'${name}' reads a response: ${samples} samples exceed ${MAX_RESPONSE_EVALUATIONS} evaluations`,
              'fewer samples',
              [name],
            ),
          );
        else {
          const study = monteCarloStudy(context, 'lhs', samples, params.seed);
          const mc = study.data;
          const standardError = typeof mc['standardError'] === 'number' ? mc['standardError'] : Number.NaN;
          items.push(...(mc['items'] as Item[]).filter((i) => i.code === 'PRB_PF_BELOW_RESOLUTION' || i.code === 'PRB_RESPONSE_FAILED'));
          if (study.pf > 0 && standardError / study.pf > covLimit)
            items.push(
              item(
                'PRB_MC_NOT_CONVERGED',
                'warning',
                `coefficient of variation of the Pf estimate is ${(standardError / study.pf).toPrecision(3)} (> ${covLimit})`,
                'more samples',
                [name],
              ),
            );
        }
      }
      const accepted = model.acceptances?.[name];
      if (accepted !== undefined) {
        const check = verifyAcceptance(ctx?.humanSignature, doc, name, accepted);
        items.push(
          check.valid
            ? item('PRB_ACCEPTED', 'info', `accepted by ${accepted.signer} (signature ${accepted.signatureId})`, 'none', [name])
            : item(
                check.code,
                'warning',
                check.reason,
                check.code === 'PRB_RESULT_STALE'
                  ? 're-run the study and hand it to the reviewer again'
                  : 'hand over to the qualified reviewer',
                [name],
              ),
        );
      }
      summaries[name] = { beta: form.beta, pfForm: form.pf, converged: form.converged, accepted: accepted !== undefined };
    }
    const status = statusOfItems(items);
    const codes = [...new Set(items.map((i) => i.code))];
    return report(
      doc,
      `check_probabilistic: ${status} over ${names.length} limit state(s)${codes.length === 0 ? '' : ` (${codes.join(', ')})`}. ${REVIEW_NOTE}`,
      { status, items, limitStates: summaries, reviewRequired: true },
    );
  },
});
