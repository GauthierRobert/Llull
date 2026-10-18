/** Resolves a limit state of the document into what a study needs: its random variables, the Nataf transform and the g(x) evaluator. */

import { evaluateExpression, extractReferences, isBuiltinConstant } from '@lib/expression';
import type { CadDocument } from '@core/model/types';
import { item, type Item } from '../fatigue/items';
import type { LimitState, RandomVariable, ReliabilityModel } from '@core/model/probabilistic';
import { reliabilityOf, limitStateOf } from './model';
import { buildTransform, type Transform } from './nataf';

export interface StudyFailure {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

export interface StudyContext {
  readonly model: ReliabilityModel;
  readonly limitState: LimitState;
  /** Variables the limit state uses, in definition order; the dimension of the u space. */
  readonly variables: readonly RandomVariable[];
  readonly transform: Transform;
  /** g at x (one value per variable of `variables`); NaN when the expression cannot be evaluated there. */
  readonly evaluate: (x: readonly number[]) => number;
  readonly items: readonly Item[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

export const isStudyFailure = (value: unknown): value is StudyFailure =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

/**
 * @failure no limit state / variables, unknown symbol, correlation not realisable -> StudyFailure with its PRB_* code
 */
export function studyContext(doc: CadDocument, limitStateName: string): StudyContext | StudyFailure {
  const model = reliabilityOf(doc);
  const limitState = limitStateOf(doc, limitStateName);
  if (limitState === undefined)
    return { code: 'PRB_LIMIT_STATE_NOT_FOUND', message: `no limit state '${limitStateName}'`, ids: [limitStateName] };
  const symbols = extractReferences(limitState.expression);
  const boundParameters = new Set(
    Object.values(model.variables).flatMap((v) => (v.binding.kind === 'parameter' ? [v.binding.parameter] : [])),
  );
  const unknown = [...symbols].filter(
    (symbol) =>
      !Object.hasOwn(model.variables, symbol) &&
      !Object.hasOwn(doc.parameters, symbol) &&
      !boundParameters.has(symbol) &&
      !isBuiltinConstant(symbol),
  );
  if (unknown.length > 0)
    return {
      code: 'PRB_EXPRESSION_INVALID',
      message: `unknown symbol(s) ${unknown.join(', ')} in '${limitState.expression}'`,
      ids: [limitState.name],
    };
  const usedBy = (variable: RandomVariable): boolean =>
    symbols.has(variable.name) || (variable.binding.kind === 'parameter' && symbols.has(variable.binding.parameter));
  const variables = model.variableOrder.flatMap((name) => {
    const variable = Object.hasOwn(model.variables, name) ? model.variables[name] : undefined;
    return variable !== undefined && usedBy(variable) ? [variable] : [];
  });
  const unresolved = variables.find(
    (variable) => variable.binding.kind === 'parameter' && !Object.hasOwn(doc.parameters, variable.binding.parameter),
  );
  if (unresolved !== undefined)
    return {
      code: 'PRB_BINDING_UNRESOLVED',
      message: `variable '${unresolved.name}' is bound to a document parameter that no longer exists`,
      ids: [unresolved.name],
    };
  if (variables.length === 0)
    return { code: 'PRB_MODEL_EMPTY', message: `limit state '${limitState.name}' uses no random variable`, ids: [limitState.name] };
  const transform = buildTransform(model, variables);
  if (typeof transform === 'string') return { code: 'PRB_CORRELATION_INVALID', message: transform, ids: variables.map((v) => v.name) };
  const env: Record<string, number> = Object.fromEntries(
    Object.entries(doc.parameters).map(([name, parameter]) => [name, parameter.value]),
  );
  const slots = variables.map(
    (variable) => [variable.name, variable.binding.kind === 'parameter' ? variable.binding.parameter : null] as const,
  );
  const evaluate = (x: readonly number[]): number => {
    slots.forEach(([name, parameter], i) => {
      env[name] = x[i] ?? 0;
      if (parameter !== null) env[parameter] = x[i] ?? 0;
    });
    const result = evaluateExpression(limitState.expression, env);
    return result.ok ? result.value : Number.NaN;
  };
  const unsourced = variables.filter((variable) => variable.citation === undefined).map((variable) => variable.name);
  const items =
    unsourced.length === 0
      ? []
      : [
          item(
            'PRB_SCATTER_UNSOURCED',
            'warning',
            `no citation for the scatter of ${unsourced.join(', ')}`,
            'redefine the variable with a citation (test report, specification, tolerance drawing)',
            unsourced,
          ),
        ];
  return {
    model,
    limitState,
    variables,
    transform,
    evaluate,
    items,
    unverified: unsourced.length > 0,
    unverifiedReasons: unsourced.map((name) => `${name}: scatter has no cited source`),
  };
}
