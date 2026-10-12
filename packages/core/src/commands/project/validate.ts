/**
 * `build_project` dry run (`validate: true`): structure, command names, required params, alias
 * refs, `=expr` evaluation and loop expansion, with issues located by path
 * (`step 4 › iter 2 › step 1`). Nothing executes; `set_parameter` actions are tracked so later
 * expressions and loop counts that read them evaluate.
 *
 * @layer core/commands
 * @pure
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { evaluateExpression, parameterValues } from '../parametric/expression';
import { getCommand } from '../commandTable';
import { MAX_LOOP_ITERATIONS } from '../limits';
import { isLoopNode, resolveLoopHeader } from './loopHeader';
import {
  REF,
  evaluateLeafExpression,
  fillPlaceholders,
  interpolate,
  isForEachStep,
  isPlanAction,
  isRepeatStep,
} from './resolve';
import { type ActionItem, type LoopNode } from './types';
import { mapStringLeaves } from '../history/regenerate';

/** Stop collecting after this many issues (a loop body error repeats once per iteration). */
const MAX_ISSUES = 50;

interface Validation {
  readonly issues: string[];
  readonly defined: Set<string>;
  readonly parameters: Record<string, number>;
  loopIterations: number;
}

/** First problem in a step's params: undefined alias, bad placeholder, or failing `=expr`. */
function findParamIssue(
  value: unknown,
  defined: ReadonlySet<string>,
  env: Record<string, number>,
): string | null {
  let first: string | null = null;
  mapStringLeaves(value, (raw) => {
    if (first !== null) return raw;
    const filled = fillPlaceholders(raw, env);
    if (filled.error !== null) {
      first = filled.error;
      return raw;
    }
    const text = filled.text;
    const ref = REF.exec(text);
    if (ref?.[1] !== undefined) {
      if (!defined.has(ref[1])) first = `references undefined alias $${ref[1]}`;
    } else if (text.startsWith('=')) {
      const r = evaluateLeafExpression(text, env).result;
      if (!r.ok) first = `expression "${text.slice(1)}": ${r.error}`;
    }
    return raw;
  });
  return first;
}

function trackParameter(state: Validation, params: Record<string, unknown>): void {
  const { name, expression } = params;
  if (typeof name !== 'string' || typeof expression !== 'string') return;
  const r = evaluateExpression(expression, state.parameters);
  if (r.ok) state.parameters[name] = r.value;
}

function validateAction(
  state: Validation,
  label: string,
  raw: ActionItem,
  vars: Record<string, number>,
): void {
  if (!isPlanAction(raw)) {
    state.issues.push(`${label}: not a valid action (needs a string "command")`);
    return;
  }
  const def = getCommand(raw.command);
  const params = raw.params ?? {};
  if (!def) {
    state.issues.push(`${label} (${raw.command}): unknown command`);
    return;
  }
  for (const req of def.paramsSchema.required) {
    if (!(req in params))
      state.issues.push(`${label} (${raw.command}): missing required param "${req}"`);
  }
  const env = { ...state.parameters, ...vars };
  const issue = findParamIssue(params, state.defined, env);
  if (issue) state.issues.push(`${label} (${raw.command}): ${issue}`);
  if (raw.command === 'set_parameter') trackParameter(state, params);
  if (raw.as) {
    const filled = interpolate(raw.as, env);
    if (filled.error !== null)
      state.issues.push(`${label} (${raw.command}): alias ${filled.error}`);
    else state.defined.add(filled.text);
  }
}

function validateLoop(
  state: Validation,
  label: string,
  node: LoopNode,
  vars: Record<string, number>,
): void {
  const header = resolveLoopHeader(node, { ...state.parameters, ...vars });
  if (header.error !== null) {
    state.issues.push(`${label}: ${header.error}`);
    return;
  }
  state.loopIterations += header.values.length;
  if (state.loopIterations > MAX_LOOP_ITERATIONS) {
    state.issues.push(
      `${label}: loops expand to more than MAX_LOOP_ITERATIONS (${MAX_LOOP_ITERATIONS}) iterations`,
    );
    return;
  }
  for (let k = 0; k < header.values.length; k++) {
    if (state.issues.length >= MAX_ISSUES) return;
    const scope = { ...vars, [header.variable]: header.values[k] as number };
    validateItems(state, node.actions, `${label} › iter ${k}`, scope, true);
  }
}

function validateItems(
  state: Validation,
  items: readonly ActionItem[],
  parent: string,
  vars: Record<string, number>,
  nested: boolean,
): void {
  items.forEach((raw, j) => {
    if (state.issues.length >= MAX_ISSUES) return;
    const label = nested ? `${parent} › step ${j}` : `step ${j}`;
    if (isLoopNode(raw)) {
      validateLoop(state, label, raw, vars);
    } else if (isRepeatStep(raw) || isForEachStep(raw)) {
      if (nested) {
        state.issues.push(
          `${label}: a repeat/for_each with "step" cannot be nested; write { repeat, actions: [...] }`,
        );
      } else {
        // Legacy single-step loops: inner expressions are validated at run time.
        state.defined.add(isRepeatStep(raw) ? (raw.repeat.as ?? '') : raw.for_each.as);
      }
    } else {
      validateAction(state, label, raw, vars);
    }
  });
}

/** Static plan check with no side effects. @pure */
export function validatePlan(doc: CadDocument, actions: ActionItem[]): CommandResult {
  const state: Validation = {
    issues: [],
    defined: new Set<string>(),
    parameters: parameterValues(doc.parameters),
    loopIterations: 0,
  };
  validateItems(state, actions, '', {}, false);
  const issues =
    state.issues.length >= MAX_ISSUES
      ? [...state.issues, `… further issues omitted (stopped at ${MAX_ISSUES})`]
      : state.issues;
  const ok = issues.length === 0;
  return {
    document: doc,
    summary: ok
      ? `Plan valid: ${actions.length} step(s) ready.`
      : `Plan invalid: ${issues.length} issue(s) — ${issues.join('; ')}.`,
    affected: [],
    data: { ok, validated: true, stepCount: actions.length, steps: [], failedAt: null, issues },
  };
}
