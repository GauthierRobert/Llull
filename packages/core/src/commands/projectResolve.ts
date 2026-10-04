import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';
import { evaluateExpression, extractReferences } from './expression';
import { MAX_PROJECT_STEPS } from './limits';
import { mapStringLeaves } from './regenerate';
import { isRecord } from '../lib/isRecord';
import {
  type PlanAction,
  type RepeatStep,
  type ForEachStep,
  type StepReport,
  type BuildProjectData,
} from './projectTypes';

/** `$alias` or `$alias[N]` — references the affected ids bound by an earlier step. */
const REF = /^\$([A-Za-z_]\w*)(?:\[(\d+)\])?$/;

interface Resolved {
  value: unknown;
  error: string | null;
}

function resolveRef(text: string, bindings: Record<string, string[]>): Resolved {
  const m = REF.exec(text);
  if (!m || m[1] === undefined) return { value: text, error: null };
  const name = m[1];
  const ids = bindings[name];
  if (ids === undefined) return { value: undefined, error: `references undefined alias $${name}` };
  const index = m[2] === undefined ? 0 : Number(m[2]);
  const id = ids[index];
  if (id === undefined) {
    return {
      value: undefined,
      error: `alias $${name} has no id at index ${index} (bound ${ids.length})`,
    };
  }
  return { value: id, error: null };
}

/** Validate-mode walk: every `$alias` ref must name an alias defined by an earlier step. */
export function findUndefinedRef(value: unknown, defined: ReadonlySet<string>): string | null {
  let firstError: string | null = null;
  mapStringLeaves(value, (text) => {
    const m = REF.exec(text);
    if (firstError === null && m && m[1] !== undefined && !defined.has(m[1])) {
      firstError = `references undefined alias $${m[1]}`;
    }
    return text;
  });
  return firstError;
}

export function isPlanAction(value: unknown): value is PlanAction {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { command?: unknown }).command === 'string'
  );
}

/** `{ [key]: {...}, step: { command: string } }` — shared shape of repeat / for_each steps. */
function isControlStep(value: unknown, key: 'repeat' | 'for_each'): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v[key] === 'object' &&
    v[key] !== null &&
    typeof v['step'] === 'object' &&
    v['step'] !== null &&
    typeof (v['step'] as Record<string, unknown>)['command'] === 'string'
  );
}

export const isRepeatStep = (value: unknown): value is RepeatStep => isControlStep(value, 'repeat');

export const isForEachStep = (value: unknown): value is ForEachStep =>
  isControlStep(value, 'for_each');

export function budgetFailure(index: number): StepReport {
  return {
    index,
    command: 'build_project',
    ok: false,
    summary: `step budget exceeded: MAX_PROJECT_STEPS (${MAX_PROJECT_STEPS}).`,
    affected: [],
  };
}

/** A rejected `build_project` run: unchanged doc plus the plan report. */
export function rejectPlan(
  doc: CadDocument,
  data: BuildProjectData,
  summary: string,
): CommandResult {
  return { document: doc, summary, affected: [], data };
}

/** Expression env: every parameter value plus the loop variables (`$i`, `$<as>`). */
export function buildEnv(doc: CadDocument, extras: Record<string, number>): Record<string, number> {
  return {
    ...Object.fromEntries(
      Object.entries(doc.parameters).map(([name, param]) => [name, param.value]),
    ),
    ...extras,
  };
}

/** A `repeat` count: number literal, or expression string (leading `=` optional) over the parameters. */
export function resolveCount(
  raw: number | string,
  doc: CadDocument,
): { count: number; error: string | null } {
  if (typeof raw === 'number') {
    return { count: raw, error: null };
  }
  const expr = raw.startsWith('=') ? raw.slice(1) : raw;
  const env = buildEnv(doc, {});
  const result = evaluateExpression(expr, env);
  if (!result.ok) return { count: 0, error: `repeat count expression error: ${result.error}` };
  return { count: result.value, error: null };
}

/**
 * `for_each` values: an array literal is used as is; a string is evaluated as arithmetic against
 * the parameters and wrapped as a one-element array (parameters only hold numbers).
 */
export function resolveForEachValues(
  raw: unknown[] | string,
  doc: CadDocument,
): { values: unknown[]; error: string | null } {
  if (Array.isArray(raw)) return { values: raw, error: null };
  const expr = raw.startsWith('=') ? raw.slice(1) : raw;
  const env = buildEnv(doc, {});
  const result = evaluateExpression(expr, env);
  if (!result.ok) return { values: [], error: `for_each values expression error: ${result.error}` };
  return { values: [result.value], error: null };
}

/** Resolve `$alias` refs and `=expr` strings (over `env`, incl. loop variables) in `value`'s string leaves. */
export function resolveExprInParam(
  value: unknown,
  bindings: Record<string, string[]>,
  env: Record<string, number>,
): Resolved {
  let firstError: string | null = null;
  const resolved = mapStringLeaves(value, (text) => {
    if (firstError !== null) return text;
    if (REF.test(text)) {
      const ref = resolveRef(text, bindings);
      firstError = ref.error;
      return ref.value;
    }
    if (!text.startsWith('=')) return text;
    // `$name` in an expression is a loop variable (`=$r * 2`): strip the `$` to match the env key.
    const expr = text.slice(1).replace(/\$([A-Za-z_]\w*)/g, '$1');
    const r = evaluateExpression(expr, env);
    if (!r.ok) {
      firstError = `expression "${expr}": ${r.error}`;
      return undefined;
    }
    return r.value;
  });
  return firstError === null
    ? { value: resolved, error: null }
    : { value: undefined, error: firstError };
}

/**
 * History meta-commands whose `params` become ANOTHER step's params: they receive the recordable
 * form (parameter `=expr` kept) so the stored step stays parametric instead of frozen numbers.
 */
export const STEP_PARAM_COMMANDS: ReadonlySet<string> = new Set([
  'insert_step',
  'edit_step_params',
]);

/**
 * Params to RECORD in featureHistory for an inner step: `$alias` refs stay resolved (ids), but an
 * `=expr` whose identifiers are all document parameters is kept verbatim so replay re-evaluates it
 * (architecture L8). Expressions using loop variables (`$i`, `$as`) are recorded as their value.
 * @pure
 */
export function recordableParams(
  raw: unknown,
  resolved: unknown,
  parameters: CadDocument['parameters'],
): unknown {
  if (typeof raw === 'string' && raw.startsWith('=') && !raw.includes('$')) {
    const refs = extractReferences(raw.slice(1));
    return [...refs].every((name) => name in parameters) ? raw : resolved;
  }
  if (Array.isArray(raw) && Array.isArray(resolved)) {
    return raw.map((item, i) => recordableParams(item, resolved[i], parameters));
  }
  if (isRecord(raw) && isRecord(resolved)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolved)) out[k] = recordableParams(raw[k], v, parameters);
    return out;
  }
  return resolved;
}
