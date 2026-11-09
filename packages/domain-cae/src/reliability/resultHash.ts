/** The result a reviewer accepts: a seeded FORM + Latin hypercube Monte Carlo of one limit state, and the hash that binds an acceptance to it. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { isStudyFailure, studyContext, type StudyFailure } from './context';
import { limitStateModelHash } from './modelHash';
import { MAX_RESPONSE_EVALUATIONS } from './responseEval';
import { formStudy, monteCarloStudy, type FormStudy, type MonteCarloStudy } from './studies';

/** Significant digits of beta and Pf in the hash: the same inputs reproduce them bit-for-bit, the rounding only absorbs platform libm differences. */
const RESULT_DIGITS = 6;
export const RESULT_FORM_ITERATIONS = 100;
export const RESULT_FORM_TOLERANCE = 1e-8;

export interface ReliabilityResult {
  readonly resultHash: string;
  readonly modelHash: string;
  readonly form: FormStudy;
  readonly monteCarlo: MonteCarloStudy;
}

const round = (value: number): string => (Number.isFinite(value) ? value.toPrecision(RESULT_DIGITS) : String(value));

/** SHA-256 over the canonical { method, seed, samples, sampling, beta, pfForm, pfMc, modelHash } of the study. */
export const resultDigest = (modelHash: string, seed: number, samples: number, beta: number, pfForm: number, pfMc: number): string =>
  sha256Hex(
    canonicalJson({
      kind: 'reliability_result',
      method: 'form+monte_carlo',
      sampling: 'lhs',
      seed,
      samples,
      beta: round(beta),
      pfForm: round(pfForm),
      pfMonteCarlo: round(pfMc),
      modelHash,
    }),
  );

/**
 * Re-runs the stated study (FORM with the default iteration limits, Latin hypercube Monte Carlo of `samples` points, `seed`) and hashes it.
 * @failure limit state that cannot be studied, or a response-backed study above the evaluation cap -> StudyFailure
 */
export function reliabilityResult(
  doc: CadDocument,
  limitState: string,
  seed: number,
  samples: number,
  ctx: ExecutionContext | undefined,
): ReliabilityResult | StudyFailure {
  const context = studyContext(doc, limitState, ctx);
  if (isStudyFailure(context)) return context;
  if (context.usesResponses && samples > MAX_RESPONSE_EVALUATIONS)
    return {
      code: 'PRB_BUDGET_EXCEEDED',
      message: `the limit state reads a response: ${samples} samples exceed ${MAX_RESPONSE_EVALUATIONS} evaluations`,
      ids: [limitState],
    };
  const modelHash = limitStateModelHash(doc, limitState) ?? '';
  const form = formStudy(context, false, RESULT_FORM_ITERATIONS, RESULT_FORM_TOLERANCE);
  const monteCarlo = monteCarloStudy(context, 'lhs', samples, seed);
  return { resultHash: resultDigest(modelHash, seed, samples, form.beta, form.pf, monteCarlo.pf), modelHash, form, monteCarlo };
}
