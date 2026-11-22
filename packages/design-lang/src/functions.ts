/**
 * User functions: `fn name(a, b = 2) = expr` lines, compiled once per run into a table the value evaluator calls.
 * @invariant functions are pure expressions (no commands, no aliases, no loop variables), take no more than their arguments and the
 *   document parameters, and the call graph is acyclic (recursion is refused before anything runs)
 * @failure duplicate or built-in name -> DESIGN_SYNTAX; a cycle -> DESIGN_FN_RECURSION naming it
 */

import { BUILTIN_FUNCTIONS } from '@lib/expression';
import type { CadDocument } from '@core/model/types';
import { DesignError } from './errors';
import type { Statement } from './parse';
import { isBuiltinFunction, type FnDef } from './valueEval';
import { calledNames, buildValueExpr } from './valueExpr';

/** The function table of `statements` (top-level `fn` lines). */
export function buildFunctions(statements: readonly Statement[], doc: Pick<CadDocument, 'units'>): Map<string, FnDef> {
  const table = new Map<string, FnDef>();
  const lines = new Map<string, number>();
  const calls = new Map<string, Set<string>>();
  for (const statement of statements) {
    if (statement.kind !== 'fn') continue;
    const { line, name } = statement;
    if (isBuiltinFunction(name))
      throw new DesignError('DESIGN_SYNTAX', line, `"${name}" is a built-in function`, 'Choose another name for the function.');
    if (table.has(name))
      throw new DesignError('DESIGN_SYNTAX', line, `function ${name} is already defined at line ${lines.get(name) ?? '?'}`, 'Rename one.');
    const ctx = { units: doc.units, paramKey: null, line };
    const body = buildValueExpr(statement.body, ctx);
    const params = statement.params.map((p) => ({ name: p.name, fallback: p.fallback === null ? null : buildValueExpr(p.fallback, ctx) }));
    table.set(name, { name, params, body });
    lines.set(name, line);
    const called = calledNames(body);
    for (const param of params) if (param.fallback !== null) calledNames(param.fallback, called);
    calls.set(name, called);
  }
  assertAcyclic(table, calls, lines);
  return table;
}

function assertAcyclic(
  table: ReadonlyMap<string, FnDef>,
  calls: ReadonlyMap<string, ReadonlySet<string>>,
  lines: ReadonlyMap<string, number>,
): void {
  const state = new Map<string, 'open' | 'done'>();
  const visit = (name: string, path: readonly string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open')
      throw new DesignError(
        'DESIGN_FN_RECURSION',
        lines.get(name) ?? 0,
        `function ${name} calls itself (${[...path.slice(path.indexOf(name)), name].join(' -> ')})`,
        'Functions may not be recursive: unroll it with a comprehension or a range.',
      );
    state.set(name, 'open');
    for (const callee of calls.get(name) ?? []) if (table.has(callee)) visit(callee, [...path, name]);
    state.set(name, 'done');
  };
  for (const name of table.keys()) visit(name, []);
}

/** True when `text` calls a function the numeric expression parser does not know (a user function or a list built-in). */
export function usesValueFunctions(text: string): boolean {
  return [...text.matchAll(/([A-Za-z_]\w*)\s*\(/g)].some((m) => !Object.hasOwn(BUILTIN_FUNCTIONS, m[1] ?? ''));
}
