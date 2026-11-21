/** The reliability methods of one limit state run together (run_reliability_study and the re-run behind an acceptance share it). */

import type { StudyContext } from './context';
import { importanceStudy } from './importanceStudy';
import { formStudy, fosmStudy, monteCarloStudy } from './studies';
import type { ResultStudy } from './types';

export const DEFAULT_FORM_ITERATIONS = 100;
export const DEFAULT_FORM_TOLERANCE = 1e-8;

export interface MethodStudies {
  readonly pf: Record<string, number | null>;
  /** FORM reliability index, null when neither form nor sorm ran. */
  readonly beta: number | null;
  readonly data: Record<string, unknown>;
  readonly compared: { method: string; value: number | null } | null;
  readonly interval: [number, number] | null;
}

/**
 * Runs every method of `study` on the limit state; options the study omits take their defaults.
 * @invariant deterministic for (context, study, seed, samples); FORM runs once for form and sorm together
 */
export function runMethods(context: StudyContext, study: ResultStudy, seed: number, samples: number): MethodStudies {
  const methods = new Set(study.methods);
  const pf: Record<string, number | null> = {};
  const data: Record<string, unknown> = { limitState: context.limitState.name, unit: context.limitState.unit, reviewRequired: true };
  const iterations = study.maxIterations ?? DEFAULT_FORM_ITERATIONS;
  const tolerance = study.tolerance ?? DEFAULT_FORM_TOLERANCE;
  let compared: { method: string; value: number | null } | null = null;
  let beta: number | null = null;
  if (methods.has('form') || methods.has('sorm')) {
    const form = formStudy(context, methods.has('sorm'), iterations, tolerance);
    beta = form.beta;
    if (methods.has('form')) {
      data['form'] = form.data;
      pf['form'] = form.pf;
    }
    if (methods.has('sorm')) {
      data['sorm'] = form.data;
      pf['sorm'] = form.pfSorm;
    }
    compared = methods.has('form') ? { method: 'FORM', value: form.pf } : { method: 'SORM', value: form.pfSorm };
  }
  let interval: [number, number] | null = null;
  if (methods.has('mc')) {
    const mc = monteCarloStudy(context, study.sampling ?? 'lhs', samples, seed);
    data['monteCarlo'] = mc.data;
    pf['mc'] = mc.pf;
    interval = mc.wilson95;
  }
  if (methods.has('is')) {
    const is = importanceStudy(context, samples, seed, iterations, tolerance);
    data['importanceSampling'] = is.data;
    pf['is'] = is.pf;
  }
  if (methods.has('fosm')) {
    const fosm = fosmStudy(context);
    data['fosm'] = fosm.data;
    pf['fosm'] = fosm.pf;
  }
  return { pf, beta, data, compared, interval };
}
