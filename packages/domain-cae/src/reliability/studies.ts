/** The reliability analyses on a resolved limit state: FORM / SORM, seeded Monte Carlo / Latin hypercube and FOSM. Pure; each returns `data`. */

import { item, type Item } from '../fatigue/items';
import type { StudyContext } from './context';
import { momentsOf } from './distributions';
import { runForm, runSorm, FD_STEP_U } from './form';
import { normalInv } from './numerics';
import { estimatePf, runFosm, sampleStats, standardNormalSamples, type SamplingMethod } from './sampling';

const unitsOf = (context: StudyContext): Record<string, string> => Object.fromEntries(context.variables.map((v) => [v.name, v.unit]));

/** Target checks: PRB_TARGET_UNSET when the limit state has none, PRB_TARGET_NOT_MET when beta / Pf misses it. */
function targetItems(context: StudyContext, beta: number | null, pf: number | null): Item[] {
  const { targetBeta, targetPf, name } = context.limitState;
  if (targetBeta === undefined && targetPf === undefined)
    return [
      item(
        'PRB_TARGET_UNSET',
        'warning',
        `limit state '${name}' has no target beta / Pf`,
        'ask the owner or the company rule for a target',
        [name],
      ),
    ];
  const missed =
    (targetBeta !== undefined && (beta === null || beta < targetBeta.value)) ||
    (targetPf !== undefined && (pf === null || pf > targetPf.value));
  return missed
    ? [
        item(
          'PRB_TARGET_NOT_MET',
          'fail',
          `beta ${beta ?? 'n/a'} / Pf ${pf ?? 'n/a'} misses the target of '${name}'`,
          'redesign; human review',
          [name],
        ),
      ]
    : [];
}

const common = (context: StudyContext, items: readonly Item[]): Record<string, unknown> => ({
  limitState: context.limitState.name,
  unit: context.limitState.unit,
  expression: context.limitState.expression,
  variables: context.variables.map((v) => v.name),
  items: [...context.items, ...items],
  unverified: context.unverified,
  unverifiedReasons: context.unverifiedReasons,
  reviewRequired: true,
});

export interface FormStudy {
  readonly data: Record<string, unknown>;
  readonly pf: number;
  readonly beta: number;
  readonly pfSorm: number | null;
  readonly converged: boolean;
}

/**
 * FORM (+ SORM) on the limit state.
 * @invariant exact beta = (muR - muS) / sqrt(sR^2 + sS^2) for a linear limit state in normal variables; importance factors sum to 1
 */
export function formStudy(context: StudyContext, sorm: boolean, maxIterations: number, tolerance: number): FormStudy {
  const g = (u: number[]): number => context.evaluate(context.transform.toX(u));
  const form = runForm(g, context.variables.length, { maxIterations, tolerance });
  const items: Item[] = [];
  const name = context.limitState.name;
  if (!form.converged)
    items.push(
      item(
        'PRB_FORM_NOT_CONVERGED',
        'warning',
        `HL-RF stopped after ${form.iterations} iteration(s) without converging (last iterate returned)`,
        'check smoothness of g, use Monte Carlo',
        [name],
      ),
    );
  const designX = context.transform.toX(form.u);
  const importance = context.transform.importance(form.u, form.alpha);
  const units = unitsOf(context);
  let sormData: Record<string, unknown> = {};
  let pfSorm: number | null = null;
  if (sorm) {
    if (!form.converged || !(form.beta > 0))
      items.push(item('PRB_SORM_INVALID', 'warning', 'SORM needs a converged design point with beta > 0', 'use Monte Carlo', [name]));
    else {
      const result = runSorm(g, form);
      pfSorm = result.pf;
      sormData = { curvatures: result.curvatures, pfSorm: result.pf, betaSorm: result.pf === null ? null : -normalInv(result.pf) };
      if (result.pf === null)
        items.push(item('PRB_SORM_INVALID', 'warning', '1 + beta * kappa <= 0 for a curvature', 'use Monte Carlo', [name]));
    }
  }
  const data = {
    ...common(context, [...items, ...targetItems(context, form.beta, form.pf)]),
    method: sorm ? 'form+sorm' : 'form',
    beta: form.beta,
    pfForm: form.pf,
    ...sormData,
    originInFailureDomain: form.gAtOrigin < 0,
    designPointU: form.u,
    designPointX: Object.fromEntries(context.variables.map((v, i) => [v.name, { value: designX[i] ?? 0, unit: units[v.name] ?? '' }])),
    alphaU: form.alpha,
    importance: Object.fromEntries(context.variables.map((v, i) => [v.name, importance[i] ?? 0])),
    gAtOrigin: form.gAtOrigin,
    gAtDesignPoint: form.g,
    iterations: form.iterations,
    converged: form.converged,
    gradient: 'central_difference',
    provenance: {
      formulas: ['HL-RF iteration in standard normal space (Nataf transform)', 'Pf = Φ(-beta)', ...(sorm ? ['Breitung SORM'] : [])],
      fdStepU: FD_STEP_U,
      tolerance,
      maxIterations,
    },
  };
  return { data, pf: form.pf, beta: form.beta, pfSorm, converged: form.converged };
}

export interface MonteCarloStudy {
  readonly data: Record<string, unknown>;
  readonly pf: number;
  readonly wilson95: [number, number];
}

/**
 * Seeded Monte Carlo / Latin hypercube on the limit state.
 * @invariant bit-identical for (model, method, samples, seed); samples where g cannot be evaluated are counted in failedSamples and excluded
 */
export function monteCarloStudy(context: StudyContext, method: SamplingMethod, samples: number, seed: number): MonteCarloStudy {
  const d = context.variables.length;
  const u = standardNormalSamples(method, samples, d, seed);
  const values: number[] = [];
  let failures = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = context.evaluate(context.transform.toX(Array.from(u.subarray(i * d, (i + 1) * d))));
    if (!Number.isFinite(value)) continue;
    values.push(value);
    if (value < 0) failures += 1;
  }
  const valid = values.length;
  const name = context.limitState.name;
  const items: Item[] = [];
  if (valid === 0)
    return {
      data: {
        ...common(context, [
          item('PRB_RESPONSE_FAILED', 'error', 'g could not be evaluated for any sample', 'check the expression', [name]),
        ]),
        method,
        samples,
        failedSamples: samples,
      },
      pf: Number.NaN,
      wilson95: [0, 1],
    };
  if (valid < samples)
    items.push(
      item(
        'PRB_RESPONSE_FAILED',
        valid < 0.99 * samples ? 'error' : 'warning',
        `g could not be evaluated for ${samples - valid} sample(s)`,
        'check the expression over the range',
        [name],
      ),
    );
  const estimate = estimatePf(failures, valid);
  if (estimate.belowResolution)
    items.push(
      item(
        'PRB_PF_BELOW_RESOLUTION',
        'warning',
        `no failure in ${valid} samples (Pf < ${estimate.upperBound})`,
        'use FORM / SORM or more samples',
        [name],
      ),
    );
  else if (estimate.standardError / estimate.pf > 0.1)
    items.push(
      item(
        'PRB_MC_NOT_CONVERGED',
        'warning',
        `coefficient of variation of the Pf estimate is ${(estimate.standardError / estimate.pf).toPrecision(3)} (> 0.1)`,
        'more samples',
        [name],
      ),
    );
  const stats = sampleStats(Float64Array.from(values));
  const data = {
    ...common(context, [...items, ...targetItems(context, estimate.betaEquivalent, estimate.pf)]),
    method,
    samples,
    validSamples: valid,
    failedSamples: samples - valid,
    seed: { value: seed, source: 'caller', defaulted: false },
    prng: 'xoshiro128**',
    g: {
      unit: context.limitState.unit,
      mean: stats.mean,
      sd: stats.sd,
      min: stats.min,
      max: stats.max,
      quantiles: stats.quantiles,
      histogram: stats.histogram,
    },
    pf: estimate.pf,
    standardError: estimate.standardError,
    wilson95: estimate.wilson95,
    betaEquivalent: estimate.betaEquivalent,
    belowResolution: estimate.belowResolution,
    ...(estimate.upperBound === null ? {} : { pfUpperBound: estimate.upperBound }),
    provenance: {
      formulas: ['inverse-CDF sampling through the Nataf transform', 'Wilson 95 % interval', 'rule of three 3/N for zero failures'],
    },
  };
  return { data, pf: estimate.pf, wilson95: estimate.wilson95 };
}

/**
 * FOSM: mean and sd of g from its linearisation at the variable means.
 * @invariant exact mean and sd for g linear in x; the Pf assumes g is normal
 */
export function fosmStudy(context: StudyContext): { data: Record<string, unknown>; pf: number | null } {
  const moments = context.variables.map((v) => momentsOf(v.distribution));
  const { correlation } = context.model;
  const rho = (i: number, j: number): number => {
    const a = context.variables[i]?.name ?? '';
    const b = context.variables[j]?.name ?? '';
    const ia = correlation?.names.indexOf(a) ?? -1;
    const ib = correlation?.names.indexOf(b) ?? -1;
    return ia < 0 || ib < 0 ? 0 : (correlation?.matrix[ia]?.[ib] ?? 0);
  };
  const result = runFosm(
    context.evaluate,
    moments.map((m) => m.mean),
    moments.map((m) => m.sd),
    rho,
  );
  const items =
    result.beta === null
      ? [item('PRB_RESPONSE_FAILED', 'error', 'g has zero variance at the means', 'check the expression', [context.limitState.name])]
      : [];
  const data = {
    ...common(context, [...items, ...targetItems(context, result.beta, result.pf)]),
    method: 'fosm',
    mean: result.mean,
    sd: result.sd,
    beta: result.beta,
    pf: result.pf,
    gradient: Object.fromEntries(context.variables.map((v, i) => [v.name, result.gradient[i] ?? 0])),
    varianceShare: Object.fromEntries(context.variables.map((v, i) => [v.name, result.variance[i] ?? 0])),
    provenance: {
      formulas: ['mu_g = g(mu)', 'sigma_g^2 = grad(g)^T Sigma grad(g) at the means', 'beta = mu_g / sigma_g, Pf = Φ(-beta) (Cornell)'],
    },
  };
  return { data, pf: result.pf };
}
