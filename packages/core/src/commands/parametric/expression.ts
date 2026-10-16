/** Parameter-aware helpers over the pure evaluator in `@lib/expression` (moved there so plugins can evaluate expressions). */

import type { Parameter } from '../../model/types';
import { evaluateExpression } from '../../lib/expression';

export { evaluateExpression, expressionSyntaxError, extractReferences, isBuiltinConstant } from '../../lib/expression';
export type { EvalResult } from '../../lib/expression';

/** Parameter name → last evaluated value (parameters in error keep their last good value). */
export function parameterValues(parameters: Readonly<Record<string, Parameter>>): Record<string, number> {
  return Object.fromEntries(Object.entries(parameters).map(([name, p]) => [name, p.value]));
}

/** A number, or an expression string evaluated over the parameter values; null when it fails. */
export function resolveNumeric(raw: number | string, parameters: Readonly<Record<string, Parameter>>): number | null {
  if (typeof raw === 'number') return raw;
  const result = evaluateExpression(raw, parameterValues(parameters));
  return result.ok ? result.value : null;
}
