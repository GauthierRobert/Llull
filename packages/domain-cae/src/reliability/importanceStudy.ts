/** Importance-sampling study of a limit state: FORM design point, then seeded sampling centred on it. */

import { item, type Item } from '../fatigue/items';
import type { StudyContext } from './context';
import { runForm } from './form';
import { importanceSampling } from './importance';

export interface ImportanceStudy {
  readonly data: Record<string, unknown>;
  readonly pf: number;
}

/**
 * Pf of the limit state by importance sampling at the FORM design point.
 * @invariant runForm always returns a finite design point (the origin when g cannot be evaluated), so the centre is never non-finite; unbiased for any design point; a non-converged FORM, an origin in the failure domain or no failure drawn each raise a named item; deterministic for (model, samples, seed)
 */
export function importanceStudy(
  context: StudyContext,
  samples: number,
  seed: number,
  maxIterations: number,
  tolerance: number,
): ImportanceStudy {
  const name = context.limitState.name;
  const g = (u: number[]): number => context.evaluate(context.transform.toX(u));
  const form = runForm(g, context.variables.length, { maxIterations, tolerance });
  const estimate = importanceSampling(g, form.u, samples, seed);
  const items: Item[] = [];
  if (!form.converged)
    items.push(
      item(
        'PRB_FORM_NOT_CONVERGED',
        'warning',
        'the design point used as centre did not converge (estimate still unbiased, less efficient)',
        'check smoothness of g',
        [name],
      ),
    );
  if (estimate.validSamples < samples)
    items.push(
      item(
        'PRB_RESPONSE_FAILED',
        'warning',
        `g could not be evaluated for ${samples - estimate.validSamples} sample(s)`,
        'check the expression over the range',
        [name],
      ),
    );
  if (estimate.failures === 0)
    items.push(
      item(
        'PRB_PF_BELOW_RESOLUTION',
        'warning',
        `no failure in ${estimate.validSamples} weighted samples`,
        'more samples or check the design point',
        [name],
      ),
    );
  return {
    data: {
      method: 'importance_sampling',
      samples,
      validSamples: estimate.validSamples,
      seed: { value: seed, source: 'caller', defaulted: false },
      prng: 'xoshiro128**',
      pf: estimate.pf,
      standardError: estimate.standardError,
      ci95: estimate.ci95,
      effectiveFailureSamples: estimate.effectiveFailureSamples,
      centre: Object.fromEntries(context.variables.map((v, i) => [v.name, form.u[i] ?? Number.NaN])),
      betaForm: form.beta,
      items,
      provenance: { formulas: ['u = u* + z, z ~ N(0, I)', 'w = exp(-u* . z - |u*|^2 / 2)', 'Pf = mean(1(g < 0) w)'] },
    },
    pf: estimate.pf,
  };
}
