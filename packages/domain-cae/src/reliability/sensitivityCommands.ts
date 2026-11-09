/** parameter_sensitivity / sensitivity_indices (PHY-18): local derivatives of a response w.r.t. document parameters, global Sobol indices. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { item, REVIEW_NOTE, type Item } from '../fatigue/items';
import { refuseReliability } from './codes';
import { isStudyFailure, studyContext } from './context';
import { buildTransform, type Transform } from './nataf';
import { reliabilityOf, responseOf } from './model';
import { MAX_RESPONSE_EVALUATIONS, queryValue, withParameters } from './responseEval';
import { sobolIndices } from './sobol';
import { standardNormalSamples } from './sampling';
import type { RandomVariable, Response } from '@cae/reliability/types';

const MAX_EXPRESSION_EVALUATIONS = 2_000_000;
/** Smoothness flag of parameter_sensitivity: |D+ - D-| > SMOOTH_RELATIVE |Dc| + SMOOTH_ABSOLUTE. */
const DEFAULT_RELATIVE_STEP = 1e-3;
const DEFAULT_BOOTSTRAP = 200;
const SMOOTH_RELATIVE = 1e-2;
const SMOOTH_ABSOLUTE = 1e-12;

const querySchema = z.object({
  command: z.string().describe('Name of a registered read-only command.'),
  params: z.record(z.string(), z.unknown()).describe('Params of that command.'),
  pointer: z.string().describe("RFC 6901 JSON pointer into { summary, affected, data } of the result, e.g. '/data/mass'."),
});

type Resolved = { readonly query: Response['query']; readonly unit: string; readonly label: string } | string;

function resolveResponse(doc: CadDocument, response: string | z.output<typeof querySchema>): Resolved {
  if (typeof response !== 'string') return { query: response, unit: '', label: `${response.command}${response.pointer}` };
  const found = responseOf(doc, response);
  return found === undefined ? `no response '${response}'` : { query: found.query, unit: found.unit, label: response };
}

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * @affects nothing; read-only, data { response, rows [{ parameter, value, unit, derivative, derivativeUnit, elasticity, forward, backward, smooth }], items, reviewRequired }
 * @invariant exact (to rounding) for a response linear in the parameter; the central difference is the derivative, forward / backward are reported with it
 * @failure unknown parameter / response, query refused at a perturbed value -> PRB_PARAMETER_NOT_FOUND / PRB_RESPONSE_NOT_FOUND / PRB_RESPONSE_FAILED (unchanged doc)
 */
export const parameterSensitivity = defineCommand({
  name: 'parameter_sensitivity',
  annotations: { readOnly: true },
  description:
    'Local sensitivity of a response to document PARAMETERS (no random variables needed): for each parameter x the response y is re-evaluated at x(1 +/- h) through the feature history (set_parameter on an in-memory copy, so geometry regenerates) ' +
    'and the central derivative dy/dx = (y(x+dx) - y(x-dx)) / 2dx, the forward and backward differences and the elasticity (x / y) dy/dx (relative change of y per relative change of x) are returned, ' +
    'with `smooth: false` when forward and backward differ by more than 1 % (a kink or step: do not trust the derivative). `response` is a name from define_response or an inline { command, params, pointer } of a read-only command. ' +
    'dx = relativeStep * |x| (default relativeStep 0.001; absolute step relativeStep when x = 0). Exact for a response linear in the parameter. ' +
    `Rows come in the order of \`parameters\`. ${REVIEW_NOTE}`,
  params: z.object({
    parameters: z.array(z.string()).min(1).describe('Names of document parameters (set_parameter) to perturb, one at a time.'),
    response: z
      .union([z.string(), querySchema])
      .describe('A defined response name (define_response) or an inline { command, params, pointer }.'),
    relativeStep: z
      .number()
      .positive()
      .max(0.5)
      .optional()
      .describe('Relative step h (default 0.001); absolute step h when the parameter value is 0.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: string[], paths: string[]): CommandResult =>
      refuseReliability(doc, 'parameter_sensitivity', code, message, ids, paths);
    const resolved = resolveResponse(doc, params.response);
    if (typeof resolved === 'string') return fail('PRB_RESPONSE_NOT_FOUND', resolved, [], ['response']);
    const missing = params.parameters.filter((name) => !Object.hasOwn(doc.parameters, name));
    if (missing.length > 0)
      return fail('PRB_PARAMETER_NOT_FOUND', `no document parameter ${missing.map((n) => `'${n}'`).join(', ')}`, missing, ['parameters']);
    const h = params.relativeStep ?? DEFAULT_RELATIVE_STEP;
    const evaluate = (name: string, value: number): number | string => {
      const perturbed = withParameters(doc, { [name]: value }, ctx);
      if (perturbed === null) return `set_parameter '${name}' = ${value} was refused`;
      const result = queryValue(perturbed, resolved.query, ctx);
      return result.ok ? result.value : result.reason;
    };
    const base = queryValue(doc, resolved.query, ctx);
    if (!base.ok) return fail('PRB_RESPONSE_FAILED', `at the current values: ${base.reason}`, [], ['response']);
    const variables = Object.values(reliabilityOf(doc).variables);
    const parameterValues = Object.fromEntries(Object.entries(doc.parameters).map(([key, parameter]) => [key, parameter.value]));
    const rows: Record<string, unknown>[] = [];
    for (const name of params.parameters) {
      const x = parameterValues[name] ?? Number.NaN;
      const step = x === 0 ? h : h * Math.abs(x);
      const up = evaluate(name, x + step);
      const down = evaluate(name, x - step);
      if (typeof up === 'string' || typeof down === 'string')
        return fail('PRB_RESPONSE_FAILED', `parameter '${name}': ${typeof up === 'string' ? up : String(down)}`, [name], ['parameters']);
      const forward = (up - base.value) / step;
      const backward = (base.value - down) / step;
      const derivative = (up - down) / (2 * step);
      const bound = variables.find((v) => v.binding.kind === 'parameter' && v.binding.parameter === name);
      const unit = bound?.unit ?? doc.units;
      rows.push({
        parameter: name,
        value: x,
        unit,
        step,
        derivative,
        derivativeUnit: `${resolved.unit === '' ? 'response unit' : resolved.unit}/${unit}`,
        elasticity: base.value === 0 || x === 0 ? null : (x / base.value) * derivative,
        forward,
        backward,
        smooth: Math.abs(forward - backward) <= SMOOTH_RELATIVE * Math.abs(derivative) + SMOOTH_ABSOLUTE,
      });
    }
    const kinks = rows.filter((row) => row['smooth'] === false).map((row) => String(row['parameter']));
    const items: Item[] =
      kinks.length === 0
        ? []
        : [
            item(
              'PRB_NOT_SMOOTH',
              'warning',
              `forward and backward differences disagree for ${kinks.join(', ')}`,
              'the response has a kink or step there; use a smaller relativeStep or sensitivity_indices',
              kinks,
            ),
          ];
    const lines = rows.map(
      (row) =>
        `d${resolved.label}/d${String(row['parameter'])} = ${Number(Number(row['derivative']).toPrecision(8))} ${String(row['derivativeUnit'])}`,
    );
    return report(
      doc,
      `parameter_sensitivity of ${resolved.label} = ${base.value}${resolved.unit === '' ? '' : ` ${resolved.unit}`} (central differences, h = ${h}): ${lines.join('; ')}.${kinks.length === 0 ? '' : ` PRB_NOT_SMOOTH: ${kinks.join(', ')}.`} ${REVIEW_NOTE}`,
      { response: { name: resolved.label, unit: resolved.unit, value: base.value }, relativeStep: h, rows, items, reviewRequired: true },
    );
  },
});

interface Target {
  readonly label: string;
  readonly unit: string;
  readonly variables: readonly RandomVariable[];
  readonly transform: Transform;
  readonly evaluate: (x: readonly number[]) => number;
  readonly usesResponses: boolean;
  readonly items: readonly Item[];
  readonly unverifiedReasons: readonly string[];
}

/** The sampled function of sensitivity_indices: a limit state g(x), or a response of the parameter-bound variables. */
function sobolTarget(
  doc: CadDocument,
  params: { response?: string | undefined; limitState?: string | undefined },
  ctx: ExecutionContext | undefined,
): Target | { code: string; message: string; ids: string[] } {
  if (params.limitState !== undefined) {
    const context = studyContext(doc, params.limitState, ctx);
    if (isStudyFailure(context)) return { code: context.code, message: context.message, ids: [...context.ids] };
    return { ...context, label: params.limitState, unit: context.limitState.unit };
  }
  const name = params.response ?? '';
  const response = responseOf(doc, name);
  if (response === undefined) return { code: 'PRB_RESPONSE_NOT_FOUND', message: `no response '${name}'`, ids: [name] };
  const model = reliabilityOf(doc);
  const variables = model.variableOrder.flatMap((n) => {
    const variable = model.variables[n];
    return variable !== undefined && variable.binding.kind === 'parameter' && Object.hasOwn(doc.parameters, variable.binding.parameter)
      ? [variable]
      : [];
  });
  if (variables.length === 0)
    return {
      code: 'PRB_MODEL_EMPTY',
      message: `no random variable is bound to a document parameter: response '${name}' has no input`,
      ids: [name],
    };
  const transform = buildTransform(model, variables);
  if (typeof transform === 'string') return { code: 'PRB_CORRELATION_INVALID', message: transform, ids: variables.map((v) => v.name) };
  const slots = variables.map((v) => (v.binding.kind === 'parameter' ? v.binding.parameter : ''));
  const evaluate = (x: readonly number[]): number => {
    const sampled = withParameters(doc, Object.fromEntries(slots.map((parameter, i) => [parameter, x[i] ?? 0])), ctx);
    const value = sampled === null ? null : queryValue(sampled, response.query, ctx);
    return value !== null && value.ok ? value.value : Number.NaN;
  };
  const unsourced = variables.filter((v) => v.citation === undefined).map((v) => v.name);
  return {
    label: name,
    unit: response.unit,
    variables,
    transform,
    evaluate,
    usesResponses: true,
    items:
      unsourced.length === 0
        ? []
        : [
            item(
              'PRB_SCATTER_UNSOURCED',
              'warning',
              `no citation for the scatter of ${unsourced.join(', ')}`,
              'redefine the variable with a citation',
              unsourced,
            ),
          ],
    unverifiedReasons: unsourced.map((n) => `${n}: scatter has no cited source`),
  };
}

const round = (value: number): string => value.toPrecision(4);

/**
 * @affects nothing; read-only, data { S { variable: { value, ci95 } }, ST, mean, variance, unit, evaluations, items, reviewRequired }
 * @invariant deterministic for (model, sampling, samples, seed, bootstrap); N (d + 2) evaluations; exact closed forms (Ishigami, linear) within the estimator error, ci95 = bootstrap percentile
 * @failure neither / both of response and limitState, unknown name, correlated inputs, failed or constant evaluations, budget -> PRB_* refusal (unchanged doc)
 */
export const sensitivityIndices = defineCommand({
  name: 'sensitivity_indices',
  annotations: { readOnly: true },
  description:
    'Global variance-based sensitivity (Sobol indices) of ONE output over the scatter of the random variables: S[name] = first-order index (share of the output variance due to the variable alone, Saltelli 2010 estimator), ' +
    'ST[name] = total-effect index (including interactions, Jansen estimator), each with a bootstrap 95 % interval (ci95). Output = a limit state g (`limitState`) or a defined response (`response`; its inputs are all random variables bound to document parameters). ' +
    'N = `samples` base points (use 2^k, e.g. 8192) cost N (d + 2) evaluations, d = number of input variables: capped at 2000000 for an expression-only limit state and 20000 when a response regenerates geometry. ' +
    'Needs an integer `seed`; deterministic. Inputs must be independent (no set_correlation between them). Indices sum to about 1 for S when there are no interactions; ST >= S. ' +
    `Also returns mean and variance of the output. For local derivatives w.r.t. parameters use parameter_sensitivity. ${REVIEW_NOTE}`,
  params: z.object({
    limitState: z
      .string()
      .optional()
      .describe('Name of a limit state (define_limit_state) whose g is analysed. Exactly one of limitState / response.'),
    response: z.string().optional().describe('Name of a response (define_response). Exactly one of limitState / response.'),
    samples: z
      .number()
      .int()
      .min(2)
      .describe('N, the number of base samples (the cost is N (d + 2) evaluations); 8192 gives about +/-0.03 on the indices.'),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .describe('Integer seed in [0, 4294967295] of the PRNG (xoshiro128**).'),
    bootstrap: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .describe('Bootstrap resamples for the 95 % intervals (default 200; 0 = none, ci95 null).'),
    sampling: z.enum(['mc', 'lhs']).optional().describe('Sample matrices A and B by plain Monte Carlo (default) or Latin hypercube.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], paths: string[]): CommandResult =>
      refuseReliability(doc, 'sensitivity_indices', code, message, [...ids], paths);
    if ((params.limitState === undefined) === (params.response === undefined))
      return fail('PRB_PARAMS_INVALID', 'give exactly one of limitState and response', [], ['limitState', 'response']);
    const target = sobolTarget(doc, params, ctx);
    if ('code' in target)
      return fail(target.code, target.message, target.ids, [params.limitState === undefined ? 'response' : 'limitState']);
    const d = target.variables.length;
    const n = params.samples;
    const evaluations = n * (d + 2);
    const cap = target.usesResponses ? MAX_RESPONSE_EVALUATIONS : MAX_EXPRESSION_EVALUATIONS;
    if (evaluations > cap)
      return fail(
        'PRB_BUDGET_EXCEEDED',
        `${n} samples x (${d} + 2) = ${evaluations} evaluations exceed the cap of ${cap}`,
        [],
        ['samples'],
      );
    const names = target.variables.map((v) => v.name);
    const model = reliabilityOf(doc);
    const correlated = model.correlation?.names.filter((name) => names.includes(name)) ?? [];
    if (correlated.length >= 2)
      return fail('PRB_SOBOL_CORRELATED', `variables ${correlated.join(', ')} are correlated`, correlated, ['limitState']);
    const u = standardNormalSamples(params.sampling ?? 'mc', n, 2 * d, params.seed);
    const rowA = (k: number): number[] => target.transform.toX(Array.from(u.subarray(k * 2 * d, k * 2 * d + d)));
    const rowB = (k: number): number[] => target.transform.toX(Array.from(u.subarray(k * 2 * d + d, (k + 1) * 2 * d)));
    const fA = new Float64Array(n);
    const fB = new Float64Array(n);
    const fAB = names.map(() => new Float64Array(n));
    for (let k = 0; k < n; k += 1) {
      const a = rowA(k);
      const b = rowB(k);
      fA[k] = target.evaluate(a);
      fB[k] = target.evaluate(b);
      for (let i = 0; i < d; i += 1) {
        const mixed = [...a];
        mixed[i] = b[i] ?? 0;
        (fAB[i] as Float64Array)[k] = target.evaluate(mixed);
      }
    }
    const failed = [fA, fB, ...fAB].reduce((sum, column) => sum + column.filter((value) => !Number.isFinite(value)).length, 0);
    if (failed > 0)
      return fail(
        'PRB_RESPONSE_FAILED',
        `${failed} of ${evaluations} evaluations of '${target.label}' were not finite numbers`,
        [target.label],
        [],
      );
    const bootstrap = params.bootstrap ?? DEFAULT_BOOTSTRAP;
    const result = sobolIndices(fA, fB, fAB, bootstrap);
    if (!(result.variance > 0))
      return fail('PRB_VARIANCE_ZERO', `'${target.label}' has zero variance over the sampled inputs`, [target.label], []);
    const table = (rows: typeof result.first): Record<string, { value: number; ci95: readonly [number, number] | null }> =>
      Object.fromEntries(rows.map((row, i) => [names[i] ?? '', { value: finite(row.value), ci95: row.ci95 }]));
    const data = {
      target: { kind: params.limitState === undefined ? 'response' : 'limitState', name: target.label },
      unit: target.unit,
      varianceUnit: `(${target.unit})^2`,
      method: 'Saltelli 2010 first order, Jansen total effect, percentile bootstrap',
      sampling: params.sampling ?? 'mc',
      samples: n,
      seed: { value: params.seed, source: 'caller', defaulted: false },
      prng: 'xoshiro128**',
      bootstrap,
      evaluations,
      mean: result.mean,
      variance: result.variance,
      variables: target.variables.map((v) => ({ name: v.name, unit: v.unit })),
      S: table(result.first),
      ST: table(result.total),
      items: target.items,
      unverified: target.unverifiedReasons.length > 0,
      unverifiedReasons: target.unverifiedReasons,
      reviewRequired: true,
    };
    const at = (rowsOf: typeof result.first, i: number): number => rowsOf[i]?.value ?? Number.NaN;
    const shown = names.map((name, i) => `${name} S ${round(at(result.first, i))} / ST ${round(at(result.total, i))}`);
    return report(
      doc,
      `sensitivity_indices of '${target.label}' (N = ${n}, ${evaluations} evaluations, seed ${params.seed}): mean ${round(result.mean)}, variance ${round(result.variance)}; ${shown.join('; ')}. ${REVIEW_NOTE}`,
      data,
    );
  },
});
