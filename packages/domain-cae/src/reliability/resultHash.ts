/** The result a reviewer accepts: any run_reliability_study method set and options on one limit state, and the hash that binds an acceptance to it. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { isStudyFailure, studyContext, type StudyFailure } from './context';
import { DEFAULT_FORM_ITERATIONS, DEFAULT_FORM_TOLERANCE, runMethods, type MethodStudies } from './methodRuns';
import { limitStateModelHash } from './modelHash';
import { MAX_RESPONSE_EVALUATIONS } from './responseEval';
import { RESULT_METHODS } from './studySchema';
import type { ResultMethod, ResultStudy } from './types';

/** Significant digits of beta and Pf in the hash: the same inputs reproduce them bit-for-bit, the rounding only absorbs platform libm differences. */
const RESULT_DIGITS = 6;

/** The check_probabilistic study (form + Latin hypercube Monte Carlo, default FORM limits): its hash is the pre-PRB-b digest, so older acceptances stay valid. */
export const DEFAULT_STUDY: ResultStudy = {
  methods: ['form', 'mc'],
  sampling: 'lhs',
  maxIterations: DEFAULT_FORM_ITERATIONS,
  tolerance: DEFAULT_FORM_TOLERANCE,
};

export interface StudyOptions {
  readonly methods?: readonly ResultMethod[] | undefined;
  readonly sampling?: 'mc' | 'lhs' | 'lhs_centred' | undefined;
  readonly maxIterations?: number | undefined;
  readonly tolerance?: number | undefined;
}

export interface ReliabilityResult {
  readonly resultHash: string;
  readonly modelHash: string;
  readonly runs: MethodStudies;
}

const round = (value: number): string => (Number.isFinite(value) ? value.toPrecision(RESULT_DIGITS) : String(value));

export const isSampledStudy = (study: ResultStudy): boolean => study.methods.some((method) => method === 'mc' || method === 'is');

/**
 * The canonical study: methods unique in RESULT_METHODS order, each option kept only when a method reads it, and then filled with its default.
 * @invariant two option sets give the same study exactly when they give the same result
 */
export function normalizeStudy(options: StudyOptions, defaultMethods: readonly ResultMethod[] = DEFAULT_STUDY.methods): ResultStudy {
  const given = new Set(options.methods ?? defaultMethods);
  const methods = RESULT_METHODS.filter((method) => given.has(method));
  const iterated = methods.some((method) => method === 'form' || method === 'sorm' || method === 'is');
  return {
    methods,
    ...(methods.includes('mc') ? { sampling: options.sampling ?? 'lhs' } : {}),
    ...(iterated
      ? { maxIterations: options.maxIterations ?? DEFAULT_FORM_ITERATIONS, tolerance: options.tolerance ?? DEFAULT_FORM_TOLERANCE }
      : {}),
  };
}

export const sameStudy = (a: ResultStudy, b: ResultStudy): boolean => canonicalJson(a) === canonicalJson(b);

/** Pre-PRB-b digest of the default study: SHA-256 over { method form+monte_carlo, sampling lhs, seed, samples, beta, pfForm, pfMc, modelHash }. */
export const defaultStudyDigest = (modelHash: string, seed: number, samples: number, beta: number, pfForm: number, pfMc: number): string =>
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
 * SHA-256 of a study result: the default study keeps its pre-PRB-b digest; every other one hashes { version 2, the normalised study, seed and samples (null when
 * nothing is sampled), beta and the Pf of every method (6 significant digits), modelHash }.
 * @invariant a change of any method, any option a method reads, seed or samples of a sampled study, the model or a rounded result changes the hash
 */
export function studyDigest(modelHash: string, study: ResultStudy, seed: number, samples: number, runs: MethodStudies): string {
  const pfOf = (method: ResultMethod): number | null => runs.pf[method] ?? null;
  if (sameStudy(study, DEFAULT_STUDY))
    return defaultStudyDigest(modelHash, seed, samples, runs.beta ?? Number.NaN, pfOf('form') ?? Number.NaN, pfOf('mc') ?? Number.NaN);
  const sampled = isSampledStudy(study);
  const pf = Object.fromEntries(
    study.methods.map((method): [string, string | null] => {
      const value = pfOf(method);
      return [method, value === null ? null : round(value)];
    }),
  );
  return sha256Hex(
    canonicalJson({
      kind: 'reliability_result',
      version: 2,
      study,
      seed: sampled ? seed : null,
      samples: sampled ? samples : null,
      beta: runs.beta === null ? null : round(runs.beta),
      pf,
      modelHash,
    }),
  );
}

/**
 * Re-runs the stated study on the current document and hashes it.
 * @failure limit state that cannot be studied, or a sampled response-backed study above the evaluation cap -> StudyFailure
 */
export function reliabilityResult(
  doc: CadDocument,
  limitState: string,
  study: ResultStudy,
  seed: number,
  samples: number,
  ctx: ExecutionContext | undefined,
): ReliabilityResult | StudyFailure {
  const context = studyContext(doc, limitState, ctx);
  if (isStudyFailure(context)) return context;
  if (context.usesResponses && isSampledStudy(study) && samples > MAX_RESPONSE_EVALUATIONS)
    return {
      code: 'PRB_BUDGET_EXCEEDED',
      message: `the limit state reads a response: ${samples} samples exceed ${MAX_RESPONSE_EVALUATIONS} evaluations`,
      ids: [limitState],
    };
  const modelHash = limitStateModelHash(doc, limitState) ?? '';
  const runs = runMethods(context, study, seed, samples);
  return { resultHash: studyDigest(modelHash, study, seed, samples, runs), modelHash, runs };
}
