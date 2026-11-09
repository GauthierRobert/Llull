/** The function a global sensitivity analysis samples: a limit state g(x), or a response of the parameter-bound random variables. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { item, type Item } from '../fatigue/items';
import { isStudyFailure, studyContext } from './context';
import { buildTransform, type Transform } from './nataf';
import { reliabilityOf, responseOf } from './model';
import { queryValue } from './responseEval';
import { isDocumentInput, withVariableValues } from './variableInputs';
import type { RandomVariable } from '@cae/reliability/types';

export interface SensitivityTarget {
  readonly label: string;
  readonly unit: string;
  readonly variables: readonly RandomVariable[];
  readonly transform: Transform;
  readonly evaluate: (x: readonly number[]) => number;
  readonly usesResponses: boolean;
  readonly items: readonly Item[];
  readonly unverifiedReasons: readonly string[];
}

/** The sampled function of sensitivity_indices / morris_screening: a limit state g(x), or a response of the parameter-bound variables. */
export function sensitivityTarget(
  doc: CadDocument,
  params: { response?: string | undefined; limitState?: string | undefined },
  ctx: ExecutionContext | undefined,
): SensitivityTarget | { code: string; message: string; ids: string[] } {
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
    return variable !== undefined &&
      isDocumentInput(variable) &&
      (variable.binding.kind !== 'parameter' || Object.hasOwn(doc.parameters, variable.binding.parameter))
      ? [variable]
      : [];
  });
  if (variables.length === 0)
    return {
      code: 'PRB_MODEL_EMPTY',
      message: `no random variable is bound to a document parameter or a material density: response '${name}' has no input`,
      ids: [name],
    };
  const transform = buildTransform(model, variables);
  if (typeof transform === 'string') return { code: 'PRB_CORRELATION_INVALID', message: transform, ids: variables.map((v) => v.name) };
  const evaluate = (x: readonly number[]): number => {
    const sampled = withVariableValues(doc, variables, x, ctx);
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
