/**
 * set_parameter / delete_parameter: the parameter table is document INPUT state (architecture L8),
 * so both are `metaHistory`; dependents re-evaluate in topological order after any change.
 *
 * @layer core/commands
 */

import type { CadDocument, Parameter } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { topologicalSort } from '../lib/topologicalSort';
import { noop } from './noop';
import { evaluateExpression, extractReferences } from './expression';
import { regenerateParameterDependents } from './dependents';

/** Parameter names ordered by dependency; names in a reference cycle are appended and listed in `cycleSet`. */
function topoSort(parameters: Readonly<Record<string, Parameter>>): {
  sorted: string[];
  cycleSet: Set<string>;
} {
  const names = Object.keys(parameters);
  const edges = names.flatMap((name) =>
    [...extractReferences((parameters[name] as Parameter).expression)]
      .filter((ref) => ref in parameters)
      .map((ref): [string, string] => [ref, name]),
  );
  const { sorted, cyclic } = topologicalSort(names, edges);
  return { sorted: [...sorted, ...cyclic], cycleSet: new Set(cyclic) };
}

/**
 * Re-evaluate every parameter in dependency order; cycles and unknown references get an `error`
 * (the last good value is kept). Shared with `activate_configuration`.
 * @pure
 */
export function reEvaluateAll(
  parameters: Readonly<Record<string, Parameter>>,
): Record<string, Parameter> {
  const { sorted, cycleSet } = topoSort(parameters);
  const result: Record<string, Parameter> = {};
  const env: Record<string, number> = {};

  for (const name of sorted) {
    const param = parameters[name]!;
    const evalResult = evaluateExpression(param.expression, env);
    if (evalResult.ok) {
      result[name] = { name, expression: param.expression, value: evalResult.value };
      env[name] = evalResult.value;
    } else {
      const errorMsg = cycleSet.has(name) ? `cycle detected involving: ${name}` : evalResult.error;
      result[name] = {
        name,
        expression: param.expression,
        value: param.value, // retain last known good value
        error: errorMsg,
      };
    }
  }

  return result;
}

/** `parameters` with `name` set to `expression`; the last value (0 when new) seeds the re-evaluation. */
export function withParameterExpression(
  parameters: Readonly<Record<string, Parameter>>,
  name: string,
  expression: string,
): Record<string, Parameter> {
  return { ...parameters, [name]: { name, expression, value: parameters[name]?.value ?? 0 } };
}

/**
 * @command set_parameter
 * @pure
 * @layer core/commands
 * @affects updates document.parameters[name] and re-evaluates all dependents
 * @invariant all parameter names remain valid after the operation
 * @failure invalid expression → parameter stored with error field, dependents re-evaluated; never throws
 */
export const setParameter = defineCommand({
  name: 'set_parameter',
  annotations: { idempotent: true, metaHistory: true },
  description:
    'Create or update a named numeric parameter in the document. ' +
    'The expression may be a numeric literal (e.g. "10") or reference other ' +
    'parameters by name using +, -, *, / and parentheses (e.g. "width * 2 + 5"). ' +
    'After setting the parameter, all dependent parameters are re-evaluated ' +
    'in topological order. An invalid expression is stored with an error message ' +
    'rather than rejecting the call. Parameter names must be non-empty strings ' +
    'containing only letters, digits, and underscores.',
  params: z.object({
    name: z
      .string()
      .describe(
        'Parameter name used as its identifier and in expressions that reference it. ' +
          'Must be non-empty and contain only letters (a-z, A-Z), digits, and underscores. ' +
          'Example: "width", "wall_thickness", "radius2".',
      ),
    expression: z
      .string()
      .describe(
        'Numeric expression defining the parameter value. ' +
          'May be a plain number ("10", "3.14") or a formula referencing other ' +
          'parameter names ("width * 2", "base_height + offset", "(a + b) / 2"). ' +
          'Supports +, -, *, /, parentheses, unary minus, and decimal numbers.',
      ),
  }),
  run: (doc, { name, expression }): CommandResult => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      return noop(
        doc,
        `set_parameter failed: name '${name}' is invalid. Use letters, digits, and underscores; must not start with a digit.`,
      );
    }
    if (expression.trim() === '') {
      return noop(doc, `set_parameter failed: expression must be a non-empty string.`);
    }

    const evaluated = reEvaluateAll(withParameterExpression(doc.parameters, name, expression));
    const param = evaluated[name]!;

    const newDoc: CadDocument = { ...doc, parameters: evaluated };

    if (param.error) {
      return {
        document: newDoc,
        summary: `set_parameter '${name}': expression '${expression}' could not be evaluated — ${param.error}. Parameter stored with error.`,
        affected: [],
      };
    }

    const dependentCount = Object.values(evaluated).filter(
      (p) => p.name !== name && extractReferences(p.expression).has(name),
    ).length;
    const { document, dependentSteps, refusal } = regenerateParameterDependents(doc, newDoc);
    if (refusal !== undefined) {
      return noop(doc, `set_parameter '${name}': ${refusal}`);
    }

    return {
      document,
      summary:
        `set_parameter '${name}' = ${param.value} (expression: '${expression}')` +
        (dependentCount > 0 ? `; ${dependentCount} dependent(s) re-evaluated` : '') +
        (dependentSteps > 0 ? `; regenerated ${dependentSteps} dependent feature step(s).` : '.'),
      affected: dependentSteps > 0 ? document.order : [],
    };
  },
});

/**
 * @command delete_parameter
 * @pure
 * @layer core/commands
 * @affects removes document.parameters[name]; dependents are re-evaluated and marked with error
 * @invariant dependent parameters remain in the document with error set
 * @failure name does not exist → no-op with descriptive summary
 */
export const deleteParameter = defineCommand({
  name: 'delete_parameter',
  annotations: { destructive: true, metaHistory: true },
  description:
    'Remove a named parameter from the document. ' +
    'The parameter record is deleted; any other parameters whose expressions ' +
    'reference this name are re-evaluated and will have their error field set to ' +
    '"unknown parameter: <name>" until they are updated. ' +
    'If the parameter does not exist, the document is left unchanged.',
  params: z.object({
    name: z
      .string()
      .describe(
        'Name of the parameter to delete. ' +
          'Must match an existing parameter name exactly (case-sensitive). ' +
          'Example: "width", "wall_thickness".',
      ),
  }),
  run: (doc, { name }): CommandResult => {
    if (!(name in doc.parameters)) {
      return noop(doc, `delete_parameter: parameter '${name}' does not exist — no change made.`);
    }

    const evaluated = reEvaluateAll(
      Object.fromEntries(Object.entries(doc.parameters).filter(([key]) => key !== name)),
    );

    const erroredDependents = Object.values(evaluated)
      .filter((p) => p.error)
      .map((p) => p.name);

    const newDoc: CadDocument = { ...doc, parameters: evaluated };

    return {
      document: newDoc,
      summary:
        `delete_parameter '${name}': removed.` +
        (erroredDependents.length > 0
          ? ` ${erroredDependents.length} dependent(s) now have errors: ${erroredDependents.join(', ')}.`
          : ''),
      affected: [],
    };
  },
});
