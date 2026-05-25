/**
 * @command set_parameter
 * @command delete_parameter
 * @pure
 * @layer core/commands
 * @affects parameters record in the CadDocument
 * @invariant All dependents are re-evaluated in topological order after any change.
 * @failure Invalid expression or missing name → no-op or error stored in parameter.error.
 */

import type { CadDocument, Parameter } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { evaluateExpression, extractReferences } from './expression';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Topological sort of parameter names by dependency order.
 * Returns both the sorted list and the set of names that are in a cycle
 * (i.e., nodes Kahn's algorithm could not process because inDegree never
 * reached 0).
 *
 * Uses Kahn's algorithm on the dependency graph.
 */
function topoSort(parameters: Readonly<Record<string, Parameter>>): {
  sorted: string[];
  cycleSet: Set<string>;
} {
  const names = Object.keys(parameters);
  const deps = new Map<string, Set<string>>();
  const rdeps = new Map<string, Set<string>>(); // reverse: rdeps[a] = params that depend on a

  for (const name of names) {
    const refs = extractReferences(parameters[name]!.expression);
    // Only count references to known parameters.
    const knownRefs = new Set([...refs].filter((r) => r in parameters));
    deps.set(name, knownRefs);
    if (!rdeps.has(name)) rdeps.set(name, new Set());
    for (const ref of knownRefs) {
      if (!rdeps.has(ref)) rdeps.set(ref, new Set());
      rdeps.get(ref)!.add(name);
    }
  }

  // Kahn's: start with nodes that have no dependencies (in-degree 0).
  const inDegree = new Map<string, number>();
  for (const name of names) {
    inDegree.set(name, deps.get(name)!.size);
  }

  const queue: string[] = [];
  for (const name of names) {
    if (inDegree.get(name) === 0) queue.push(name);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(name);
    for (const dependent of rdeps.get(name) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  // Any remaining nodes (inDegree > 0) are genuinely in a cycle.
  const cycleSet = new Set<string>();
  for (const name of names) {
    if (!sorted.includes(name)) {
      sorted.push(name);
      cycleSet.add(name);
    }
  }

  return { sorted, cycleSet };
}

/**
 * Re-evaluate ALL parameters in topological order and return a new parameters
 * record. Parameters with cycles or unknown references are marked with `error`.
 *
 * @pure — does not mutate input.
 */
function reEvaluateAll(
  parameters: Readonly<Record<string, Parameter>>,
): Record<string, Parameter> {
  const { sorted, cycleSet } = topoSort(parameters);
  const result: Record<string, Parameter> = {};
  // Build env incrementally as we evaluate in topo order.
  const env: Record<string, number> = {};

  for (const name of sorted) {
    const param = parameters[name]!;
    const evalResult = evaluateExpression(param.expression, env);
    if (evalResult.ok) {
      result[name] = { name, expression: param.expression, value: evalResult.value };
      env[name] = evalResult.value;
    } else {
      // Only label as "cycle detected" when the node is genuinely in the Kahn
      // residue (cycleSet). Otherwise surface the evaluator's real error string
      // so parse errors and unknown-reference errors remain truthful (AC5).
      const errorMsg = cycleSet.has(name)
        ? `cycle detected involving: ${name}`
        : evalResult.error;
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

// ---------------------------------------------------------------------------
// set_parameter
// ---------------------------------------------------------------------------

interface SetParameterParams {
  name: string;
  expression: string;
}

/**
 * @command set_parameter
 * @pure
 * @layer core/commands
 * @affects updates document.parameters[name] and re-evaluates all dependents
 * @invariant all parameter names remain valid after the operation
 * @failure invalid expression → parameter stored with error field, dependents re-evaluated; never throws
 */
export const setParameter: CommandDefinition<SetParameterParams> = {
  name: 'set_parameter',
  description:
    'Create or update a named numeric parameter in the document. ' +
    'The expression may be a numeric literal (e.g. "10") or reference other ' +
    'parameters by name using +, -, *, / and parentheses (e.g. "width * 2 + 5"). ' +
    'After setting the parameter, all dependent parameters are re-evaluated ' +
    'in topological order. An invalid expression is stored with an error message ' +
    'rather than rejecting the call. Parameter names must be non-empty strings ' +
    'containing only letters, digits, and underscores.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Parameter name used as its identifier and in expressions that reference it. ' +
          'Must be non-empty and contain only letters (a-z, A-Z), digits, and underscores. ' +
          'Example: "width", "wall_thickness", "radius2".',
      },
      expression: {
        type: 'string',
        description:
          'Numeric expression defining the parameter value. ' +
          'May be a plain number ("10", "3.14") or a formula referencing other ' +
          'parameter names ("width * 2", "base_height + offset", "(a + b) / 2"). ' +
          'Supports +, -, *, /, parentheses, unary minus, and decimal numbers.',
      },
    },
    required: ['name', 'expression'],
  },
  run: (doc, { name, expression }): CommandResult => {
    // Validate name: must be a valid identifier.
    if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      return {
        document: doc,
        summary: `set_parameter failed: name '${String(name)}' is invalid. Use letters, digits, and underscores; must not start with a digit.`,
        affected: [],
      };
    }
    if (typeof expression !== 'string' || expression.trim() === '') {
      return {
        document: doc,
        summary: `set_parameter failed: expression must be a non-empty string.`,
        affected: [],
      };
    }

    // Insert/update the parameter, then re-evaluate all parameters in topo order.
    const withNew: Record<string, Parameter> = {
      ...doc.parameters,
      [name]: {
        name,
        expression,
        // Optimistic initial value; reEvaluateAll will overwrite with the real one.
        value: doc.parameters[name]?.value ?? 0,
      },
    };

    const evaluated = reEvaluateAll(withNew);
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

    return {
      document: newDoc,
      summary:
        `set_parameter '${name}' = ${param.value} (expression: '${expression}')` +
        (dependentCount > 0 ? `; ${dependentCount} dependent(s) re-evaluated.` : '.'),
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// delete_parameter
// ---------------------------------------------------------------------------

interface DeleteParameterParams {
  name: string;
}

/**
 * @command delete_parameter
 * @pure
 * @layer core/commands
 * @affects removes document.parameters[name]; dependents are re-evaluated and marked with error
 * @invariant dependent parameters remain in the document with error set
 * @failure name does not exist → no-op with descriptive summary
 */
export const deleteParameter: CommandDefinition<DeleteParameterParams> = {
  name: 'delete_parameter',
  description:
    'Remove a named parameter from the document. ' +
    'The parameter record is deleted; any other parameters whose expressions ' +
    'reference this name are re-evaluated and will have their error field set to ' +
    '"unknown parameter: <name>" until they are updated. ' +
    'If the parameter does not exist, the document is left unchanged.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Name of the parameter to delete. ' +
          'Must match an existing parameter name exactly (case-sensitive). ' +
          'Example: "width", "wall_thickness".',
      },
    },
    required: ['name'],
  },
  run: (doc, { name }): CommandResult => {
    if (typeof name !== 'string' || !(name in doc.parameters)) {
      return {
        document: doc,
        summary: `delete_parameter: parameter '${String(name)}' does not exist — no change made.`,
        affected: [],
      };
    }

    // Build the new parameters map without the deleted name.
    const withoutDeleted: Record<string, Parameter> = {};
    for (const [k, v] of Object.entries(doc.parameters)) {
      if (k !== name) withoutDeleted[k] = v;
    }

    // Re-evaluate all remaining parameters; dependents will fail with
    // "unknown parameter: <name>" naturally via the evaluator.
    const evaluated = reEvaluateAll(withoutDeleted);

    const erroredDependents = Object.values(evaluated).filter((p) => p.error).map((p) => p.name);

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
};
