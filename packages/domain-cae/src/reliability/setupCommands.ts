/** define_random_variable / delete_random_variable / set_correlation / define_limit_state (PHY-18): the probabilistic model of the document. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { expressionSyntaxError, extractReferences, isBuiltinConstant } from '@lib/expression';
import { nextId } from '@lib/id';
import { distributionIssue, distributionSchema } from './distributions';
import { refuseReliability } from './codes';
import { cholesky } from './numerics';
import type { LimitState, RandomVariable } from '@core/model/probabilistic';
import { limitStateOf, reliabilityOf, variableOf, withReliability } from './model';

const IDENTIFIER = /^[A-Za-z_]\w*$/;

const citationSchema = z.object({
  text: z.string().min(1).describe('What the scatter is based on: test report, specification, tolerance drawing, handbook.'),
  url: z.string().optional().describe('Optional link to the source.'),
  locator: z.string().optional().describe('Optional page, table or clause inside the source.'),
});

const targetSchema = (what: string): z.ZodObject<{ value: z.ZodNumber; source: z.ZodString }> =>
  z.object({
    value: z.number().describe(`${what}.`),
    source: z.string().describe('Who set it: the owner or the company rule. There is no default target.'),
  });

/**
 * @affects doc.reliability.variables (adds or replaces the variable called `name`; affected: [variable id])
 * @invariant distribution parameters valid (sd > 0, lognormal mean > 0, min < max); a parameter binding names an existing document parameter
 * @failure bad name, name of a document parameter or built-in constant, invalid distribution, unknown parameter -> PRB_DISTRIBUTION_INVALID / PRB_PARAMS_INVALID / PRB_BINDING_UNRESOLVED (unchanged doc)
 */
export const defineRandomVariable = defineCommand({
  name: 'define_random_variable',
  description:
    'Define (or replace, by name) a random variable of the probabilistic model: a scattered input with a distribution. Use its `name` as a symbol in define_limit_state expressions. ' +
    'Distributions: normal {mean, sd}; lognormal {mean, sd} (the mean and sd of X itself, not of ln X); uniform {min, max}; weibull {shape, scale}; gumbel {location, scale}. ' +
    'Give the unit and cite the source of the scatter (`citation`), otherwise every result is marked unverified (PRB_SCATTER_UNSOURCED). `binding` is { kind: "free" } ' +
    '(a symbol used only in expressions, default) or { kind: "parameter", parameter } (links the variable to an existing document parameter). ' +
    'Returns the variable id (rv-<step>.<k>) in affected[0]. Next: define_limit_state, then reliability_form / propagate_uncertainty / run_reliability_study.',
  params: z.object({
    name: z
      .string()
      .describe('Symbol of the variable: letters, digits and underscores, not starting with a digit (e.g. "R", "yield_strength").'),
    unit: z.string().describe("Unit of the variable's values, e.g. 'MPa', 'mm', '1'. Recorded for reports; values are not converted."),
    distribution: distributionSchema.describe('Marginal distribution of the variable.'),
    binding: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('free').describe('A symbol for expressions only.') }),
        z.object({
          kind: z.literal('parameter').describe('Linked to a document parameter.'),
          parameter: z.string().describe('Name of an existing document parameter (set_parameter).'),
        }),
      ])
      .optional()
      .describe('What the variable stands for. Default { kind: "free" }.'),
    citation: citationSchema
      .optional()
      .describe('Source of the scatter. Strongly recommended: without it results carry PRB_SCATTER_UNSOURCED and unverified: true.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[]): CommandResult =>
      refuseReliability(doc, 'define_random_variable', code, message, [params.name], paths);
    if (!IDENTIFIER.test(params.name))
      return fail('PRB_PARAMS_INVALID', `name '${params.name}' is not an identifier (letters, digits, underscore)`, ['name']);
    if (Object.hasOwn(doc.parameters, params.name) || isBuiltinConstant(params.name))
      return fail(
        'PRB_PARAMS_INVALID',
        `name '${params.name}' is ${Object.hasOwn(doc.parameters, params.name) ? 'a document parameter' : 'a built-in constant'}: a limit-state expression could not tell the variable from it; choose another name`,
        ['name'],
      );
    const issue = distributionIssue(params.distribution);
    if (issue !== null) return fail('PRB_DISTRIBUTION_INVALID', issue, ['distribution']);
    const binding = params.binding ?? { kind: 'free' as const };
    if (binding.kind === 'parameter' && !Object.hasOwn(doc.parameters, binding.parameter))
      return fail('PRB_BINDING_UNRESOLVED', `no document parameter '${binding.parameter}'`, ['binding', 'parameter']);
    const model = reliabilityOf(doc);
    const id = nextId('rv');
    const variable: RandomVariable = {
      id,
      name: params.name,
      unit: params.unit,
      distribution: params.distribution,
      binding,
      ...(params.citation === undefined ? {} : { citation: params.citation }),
    };
    const replaced = variableOf(doc, params.name) !== undefined;
    const next = withReliability(doc, {
      ...model,
      variables: { ...model.variables, [params.name]: variable },
      variableOrder: replaced ? model.variableOrder : [...model.variableOrder, params.name],
    });
    return changed(
      next,
      `${replaced ? 'Replaced' : 'Defined'} random variable ${id} '${params.name}' [${params.unit}] (${params.distribution.kind}${params.citation === undefined ? ', unsourced scatter' : ''}).`,
      [id],
    );
  },
});

/**
 * @affects doc.reliability.variables (removes the variable and its correlation row; affected: [variable id])
 * @failure unknown name -> PRB_VARIABLE_NOT_FOUND; used by a limit state, directly or through its bound parameter -> PRB_EXPRESSION_INVALID (unchanged doc)
 */
export const deleteRandomVariable = defineCommand({
  name: 'delete_random_variable',
  annotations: { destructive: true },
  description:
    'Delete a random variable by name. Refused while a limit state still uses it (redefine or replace that limit state first). Its row is removed from the correlation matrix.',
  params: z.object({ name: z.string().describe('Name of the random variable to delete.') }),
  run: (doc, params): CommandResult => {
    const variable = variableOf(doc, params.name);
    if (variable === undefined)
      return refuseReliability(doc, 'delete_random_variable', 'PRB_VARIABLE_NOT_FOUND', `no random variable '${params.name}'`, [
        params.name,
      ]);
    const model = reliabilityOf(doc);
    const symbols = variable.binding.kind === 'parameter' ? [params.name, variable.binding.parameter] : [params.name];
    const user = Object.values(model.limitStates).find((limitState) => {
      const references = extractReferences(limitState.expression);
      return symbols.some((symbol) => references.has(symbol));
    });
    if (user !== undefined)
      return refuseReliability(
        doc,
        'delete_random_variable',
        'PRB_EXPRESSION_INVALID',
        `limit state '${user.name}' still uses '${params.name}'${variable.binding.kind === 'parameter' ? ` (or its bound parameter '${variable.binding.parameter}')` : ''}`,
        [params.name, user.name],
      );
    const variables = Object.fromEntries(Object.entries(model.variables).filter(([name]) => name !== params.name));
    const correlation = model.correlation;
    const keep = correlation === undefined ? [] : correlation.names.map((name, i) => (name === params.name ? -1 : i)).filter((i) => i >= 0);
    const next = withReliability(doc, {
      variables,
      variableOrder: model.variableOrder.filter((name) => name !== params.name),
      limitStates: model.limitStates,
      limitStateOrder: model.limitStateOrder,
      ...(correlation !== undefined && keep.length > 1
        ? {
            correlation: {
              names: keep.map((i) => correlation.names[i] ?? ''),
              matrix: keep.map((i) => keep.map((j) => correlation.matrix[i]?.[j] ?? 0)),
            },
          }
        : {}),
    });
    return changed(next, `Deleted random variable ${variable.id} '${params.name}'.`, [variable.id]);
  },
});

/**
 * @affects doc.reliability.correlation (replaces the matrix)
 * @invariant matrix square, symmetric, unit diagonal, off-diagonals in (-1, 1), positive definite; every name is a defined variable
 * @failure anything else -> PRB_CORRELATION_INVALID / PRB_VARIABLE_NOT_FOUND (unchanged doc)
 */
export const setCorrelation = defineCommand({
  name: 'set_correlation',
  description:
    'Set the correlation of random variables (replaces any previous matrix). `names` lists the variables, `matrix` is their correlation matrix (symmetric, ones on the diagonal, ' +
    'off-diagonals in (-1, 1), positive definite). Variables not listed stay independent. For non-normal marginals the correlation is the correlation of the values X ' +
    '(a Nataf transform is applied, so a pair whose correlation is not attainable for its distributions is refused).',
  params: z.object({
    names: z.array(z.string()).min(2).describe('Names of at least two defined random variables, in the order of the matrix rows.'),
    matrix: z.array(z.array(z.number())).describe('Correlation matrix, names.length x names.length, e.g. [[1, 0.5], [0.5, 1]].'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseReliability(doc, 'set_correlation', code, message, params.names, paths);
    const n = params.names.length;
    if (new Set(params.names).size !== n) return fail('PRB_CORRELATION_INVALID', 'names must be distinct', ['names']);
    const missing = params.names.filter((name) => variableOf(doc, name) === undefined);
    if (missing.length > 0) return fail('PRB_VARIABLE_NOT_FOUND', `no random variable ${missing.join(', ')}`, ['names']);
    const { matrix } = params;
    if (matrix.length !== n || matrix.some((row) => row.length !== n))
      return fail('PRB_CORRELATION_INVALID', `matrix must be ${n} x ${n}`, ['matrix']);
    for (let i = 0; i < n; i += 1) {
      if (matrix[i]?.[i] !== 1) return fail('PRB_CORRELATION_INVALID', `diagonal entry [${i}][${i}] must be 1`, ['matrix']);
      for (let j = 0; j < i; j += 1) {
        const value = matrix[i]?.[j] ?? Number.NaN;
        if (!(Math.abs(value) < 1) || Math.abs(value - (matrix[j]?.[i] ?? Number.NaN)) > 1e-12)
          return fail('PRB_CORRELATION_INVALID', `entries [${i}][${j}] and [${j}][${i}] must be equal and in (-1, 1)`, ['matrix']);
      }
    }
    if (cholesky(matrix) === null) return fail('PRB_CORRELATION_INVALID', 'matrix is not positive definite', ['matrix']);
    const model = reliabilityOf(doc);
    return changed(
      withReliability(doc, { ...model, correlation: { names: params.names, matrix: matrix.map((row) => [...row]) } }),
      `Set the correlation of ${params.names.join(', ')} (${n} x ${n}).`,
      params.names.map((name) => variableOf(doc, name)?.id ?? name),
    );
  },
});

/**
 * @affects doc.reliability.limitStates (adds or replaces the limit state called `name`; affected: [limit state id])
 * @invariant expression parses; every symbol is a random variable, a document parameter or pi / tau; failure is g < 0
 * @failure bad name / expression / unknown symbol / bad target -> PRB_PARAMS_INVALID / PRB_EXPRESSION_INVALID / PRB_TARGET_INVALID (unchanged doc)
 */
export const defineLimitState = defineCommand({
  name: 'define_limit_state',
  description:
    'Define (or replace, by name) a limit-state function g(x): the part FAILS when g < 0 (e.g. "R - S" for resistance minus load effect, "22 - mass"). ' +
    '`expression` uses + - * / parentheses, numbers, the functions sin cos tan asin acos atan atan2 sqrt abs exp ln log10 pow hypot min max (no ^: write pow(x, 2)), ' +
    'random variables (define_random_variable) and document parameters. Evaluated safely (no eval). Optional targetBeta / targetPf record the owner or company requirement; ' +
    'there is no default target. Returns the limit state id (ls-<step>.<k>) in affected[0].',
  params: z.object({
    name: z.string().describe('Name of the limit state (letters, digits, underscores), used by the reliability and propagation commands.'),
    expression: z.string().describe('g(x) as an expression over random variables and parameters. g < 0 means failure.'),
    unit: z.string().describe("Unit of g, e.g. 'MPa'."),
    targetBeta: targetSchema('Required reliability index (> 0)').optional().describe('Required beta, if the owner or a rule sets one.'),
    targetPf: targetSchema('Allowed failure probability in (0, 1)').optional().describe('Allowed Pf, if the owner or a rule sets one.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[]): CommandResult =>
      refuseReliability(doc, 'define_limit_state', code, message, [params.name], paths);
    if (!IDENTIFIER.test(params.name)) return fail('PRB_PARAMS_INVALID', `name '${params.name}' is not an identifier`, ['name']);
    const syntax = expressionSyntaxError(params.expression);
    if (syntax !== null) return fail('PRB_EXPRESSION_INVALID', syntax, ['expression']);
    const model = reliabilityOf(doc);
    const unknown = [...extractReferences(params.expression)].filter(
      (symbol) => !Object.hasOwn(model.variables, symbol) && !Object.hasOwn(doc.parameters, symbol) && !isBuiltinConstant(symbol),
    );
    if (unknown.length > 0)
      return fail('PRB_EXPRESSION_INVALID', `unknown symbol(s) ${unknown.join(', ')}: define the random variables first`, ['expression']);
    const { targetBeta, targetPf } = params;
    if (
      (targetBeta !== undefined && (!(targetBeta.value > 0) || targetBeta.source.trim() === '')) ||
      (targetPf !== undefined && (!(targetPf.value > 0 && targetPf.value < 1) || targetPf.source.trim() === ''))
    )
      return fail('PRB_TARGET_INVALID', 'targetBeta needs value > 0, targetPf a value in (0, 1), both a source', ['targetBeta']);
    const id = nextId('ls');
    const limitState: LimitState = {
      id,
      name: params.name,
      expression: params.expression,
      unit: params.unit,
      ...(targetBeta === undefined ? {} : { targetBeta }),
      ...(targetPf === undefined ? {} : { targetPf }),
    };
    const replaced = limitStateOf(doc, params.name) !== undefined;
    const next = withReliability(doc, {
      ...model,
      limitStates: { ...model.limitStates, [params.name]: limitState },
      limitStateOrder: replaced ? model.limitStateOrder : [...model.limitStateOrder, params.name],
    });
    return changed(
      next,
      `${replaced ? 'Replaced' : 'Defined'} limit state ${id} '${params.name}': g = ${params.expression} [${params.unit}], failure when g < 0.`,
      [id],
    );
  },
});
