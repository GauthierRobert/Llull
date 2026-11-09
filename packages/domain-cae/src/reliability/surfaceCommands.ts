/** response_surface_study (PHY-18 M4, TR-PRB-13): a quadratic response surface from a Latin hypercube design, then FORM / Monte Carlo on the surface. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { item, REVIEW_NOTE, type Item } from '../fatigue/items';
import { refuseReliability } from './codes';
import { runForm } from './form';
import { MAX_RESPONSE_EVALUATIONS } from './responseEval';
import { estimatePf, standardNormalSamples } from './sampling';
import { sensitivityTarget } from './sensitivityTarget';
import { fitQuadraticSurface, quadraticTerms } from './surface';

const MAX_EXPRESSION_EVALUATIONS = 2_000_000;
const MAX_SURFACE_SAMPLES = 2_000_000;
const DEFAULT_SPREAD = 1.5;
const DEFAULT_SURFACE_SAMPLES = 100_000;
/** Leave-one-out RMSE above this share of the response's own spread flags PRB_SURFACE_RESIDUAL. */
const RESIDUAL_LIMIT = 0.05;
/** A FORM design point farther than this many spreads from the origin lies outside the fitted region. */
const EXTRAPOLATION_FACTOR = 2;

/**
 * @affects nothing; read-only, data { surface { terms, rSquared, looRmse, looRelative, maxLeverage }, design, form, monteCarlo, items, reviewRequired }
 * @invariant a quadratic limit state is reproduced exactly (rSquared 1, looRmse ~ 0, FORM / Pf equal the direct ones); deterministic for (model, points, spread, seed, samples)
 * @failure neither / both of limitState and response, too few points, singular design, non-finite evaluation at a design point, budget -> PRB_* refusal (unchanged doc)
 */
export const responseSurfaceStudy = defineCommand({
  name: 'response_surface_study',
  annotations: { readOnly: true },
  description:
    'Cheap reliability of an expensive limit state: evaluate it at `points` Latin hypercube points of the standard normal space (scaled by `spread`), fit a full quadratic response surface (least squares), ' +
    'then run FORM and a seeded Monte Carlo on the SURFACE (no further evaluations). Needs points > (d + 1)(d + 2) / 2 for d input variables. Reports the surface quality: rSquared and the leave-one-out RMSE ' +
    '(looRelative = RMSE over the standard deviation of the response at the design points); PRB_SURFACE_RESIDUAL (warning) when it exceeds 5 %: then the Pf is not trustworthy, use run_reliability_study. ' +
    'Exact for a quadratic g. Output = a limit state g (`limitState`) or a response (`response`, inputs = the random variables bound to document parameters; failure when the response is negative). ' +
    'Evaluations: `points` (cap 20000 for a response, 2000000 for an expression). A surface fitted over a narrow spread extrapolates badly to a far design point: raise `spread` (default 1.5) for small Pf. ' +
    REVIEW_NOTE,
  params: z.object({
    limitState: z.string().optional().describe('Name of a limit state. Exactly one of limitState / response.'),
    response: z.string().optional().describe('Name of a response (define_response); g = response, failure when negative.'),
    points: z
      .number()
      .int()
      .min(3)
      .describe('Number of design points (more than the (d + 1)(d + 2) / 2 terms of the surface; 3 to 5 times that is usual).'),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .describe('Integer seed in [0, 4294967295] (design and Monte Carlo).'),
    spread: z
      .number()
      .positive()
      .max(6)
      .optional()
      .describe(`Scale of the design in standard deviations of u (default ${DEFAULT_SPREAD}).`),
    samples: z
      .number()
      .int()
      .min(2)
      .max(MAX_SURFACE_SAMPLES)
      .optional()
      .describe(`Monte Carlo samples on the surface (default ${DEFAULT_SURFACE_SAMPLES}).`),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], paths: string[]): CommandResult =>
      refuseReliability(doc, 'response_surface_study', code, message, [...ids], paths);
    if ((params.limitState === undefined) === (params.response === undefined))
      return fail('PRB_PARAMS_INVALID', 'give exactly one of limitState and response', [], ['limitState', 'response']);
    const target = sensitivityTarget(doc, params, ctx);
    if ('code' in target)
      return fail(target.code, target.message, target.ids, [params.limitState === undefined ? 'response' : 'limitState']);
    const d = target.variables.length;
    const terms = quadraticTerms(d);
    if (params.points <= terms)
      return fail(
        'PRB_PARAMS_INVALID',
        `${params.points} points cannot fit the ${terms} terms of a quadratic in ${d} variables: use more than ${terms}`,
        [],
        ['points'],
      );
    const cap = target.usesResponses ? MAX_RESPONSE_EVALUATIONS : MAX_EXPRESSION_EVALUATIONS;
    if (params.points > cap)
      return fail('PRB_BUDGET_EXCEEDED', `${params.points} design points exceed the cap of ${cap} evaluations`, [], ['points']);
    const samples = params.samples ?? DEFAULT_SURFACE_SAMPLES;
    if (samples * d > 20_000_000)
      return fail('PRB_BUDGET_EXCEEDED', `${samples} samples x ${d} variables exceed the memory cap`, [], ['samples']);
    const spread = params.spread ?? DEFAULT_SPREAD;
    const flat = standardNormalSamples('lhs', params.points, d, params.seed);
    const design = Array.from({ length: params.points }, (_, k) =>
      Array.from(flat.subarray(k * d, (k + 1) * d), (value) => value * spread),
    );
    const evaluate = (u: readonly number[]): number => target.evaluate(target.transform.toX(u));
    const values = design.map(evaluate);
    const failed = values.filter((value) => !Number.isFinite(value)).length;
    if (failed > 0)
      return fail(
        'PRB_RESPONSE_FAILED',
        `${failed} of ${params.points} design points of '${target.label}' were not finite numbers`,
        [target.label],
        [],
      );
    const surface = fitQuadraticSurface(design, values);
    if (surface === null) return fail('PRB_PARAMS_INVALID', 'the design is singular: change the seed or add points', [], ['points']);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const spreadOfValues = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
    const looRelative = spreadOfValues > 0 ? surface.looRmse / spreadOfValues : surface.looRmse > 0 ? Number.POSITIVE_INFINITY : 0;
    if (!Number.isFinite(looRelative))
      return fail(
        'PRB_SURFACE_UNRELIABLE',
        'a design point alone determines its own fit (leverage 1): the leave-one-out residual does not exist; add points or change the seed',
        [target.label],
        ['points'],
      );
    const items: Item[] = [...target.items];
    if (looRelative > RESIDUAL_LIMIT)
      items.push(
        item(
          'PRB_SURFACE_RESIDUAL',
          'warning',
          `leave-one-out RMSE is ${(100 * looRelative).toPrecision(3)} % of the response spread (> ${100 * RESIDUAL_LIMIT} %): the quadratic surface does not represent the response`,
          'add points, narrow or widen spread, or use run_reliability_study on the real limit state',
          [target.label],
        ),
      );
    const form = runForm((u) => surface.evaluate(u), d, { maxIterations: 100, tolerance: 1e-8 });
    if (!form.converged)
      items.push(item('PRB_FORM_NOT_CONVERGED', 'warning', 'FORM on the surface did not converge', 'check the surface', [target.label]));
    const radius = Math.sqrt(form.u.reduce((sum, value) => sum + value * value, 0));
    if (radius > EXTRAPOLATION_FACTOR * spread)
      items.push(
        item(
          'PRB_SURFACE_EXTRAPOLATION',
          'warning',
          `the design point is at |u| = ${radius.toPrecision(3)}, beyond ${EXTRAPOLATION_FACTOR} x spread (${EXTRAPOLATION_FACTOR * spread}): the Pf comes from extrapolating the surface`,
          'raise spread so the design covers the design point, or use run_reliability_study',
          [target.label],
        ),
      );
    const draws = standardNormalSamples('lhs', samples, d, (params.seed + 1) >>> 0);
    let failures = 0;
    for (let k = 0; k < samples; k += 1) if (surface.evaluate(Array.from(draws.subarray(k * d, (k + 1) * d))) < 0) failures += 1;
    const mc = estimatePf(failures, samples);
    const names = target.variables.map((v) => v.name);
    const designX = target.transform.toX(form.u);
    return report(
      doc,
      `response_surface_study of '${target.label}' (${params.points} points, ${terms}-term quadratic, R2 ${surface.rSquared.toPrecision(5)}, LOO ${(100 * looRelative).toPrecision(3)} %): ` +
        `FORM beta ${form.beta.toPrecision(5)} Pf ${form.pf.toPrecision(5)}, Monte Carlo on the surface Pf ${mc.pf.toPrecision(5)}${items.some((i) => i.code === 'PRB_SURFACE_RESIDUAL') ? ' (PRB_SURFACE_RESIDUAL)' : ''}. ${REVIEW_NOTE}`,
      {
        target: { kind: params.limitState === undefined ? 'response' : 'limitState', name: target.label },
        unit: target.unit,
        design: {
          kind: 'latin hypercube (standard normal space)',
          points: params.points,
          spread,
          seed: { value: params.seed, source: 'caller', defaulted: false },
          evaluations: params.points,
        },
        surface: {
          terms,
          rSquared: surface.rSquared,
          looRmse: surface.looRmse,
          looRelative,
          maxLeverage: surface.maxLeverage,
          coefficients: surface.coefficients,
        },
        form: {
          beta: form.beta,
          pfForm: form.pf,
          converged: form.converged,
          designPointU: form.u,
          designPointX: Object.fromEntries(
            names.map((name, i) => [name, { value: designX[i] ?? Number.NaN, unit: target.variables[i]?.unit ?? '' }]),
          ),
        },
        monteCarlo: { samples, pf: mc.pf, standardError: mc.standardError, wilson95: mc.wilson95, belowResolution: mc.belowResolution },
        variables: names,
        items,
        unverified: target.unverifiedReasons.length > 0,
        unverifiedReasons: target.unverifiedReasons,
        reviewRequired: true,
      },
    );
  },
});
