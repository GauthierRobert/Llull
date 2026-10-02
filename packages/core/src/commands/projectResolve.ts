import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';
import { evaluateExpression, extractReferences } from './expression';
import { MAX_PROJECT_STEPS } from './limits';
import { isRecord } from '../lib/isRecord';
import {
  type PlanAction,
  type RepeatStep,
  type ForEachStep,
  type StepReport,
  type BuildProjectData,
} from './projectTypes';

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

/** `$alias` or `$alias[N]` — references the affected ids bound by an earlier step. */
export const REF = /^\$([A-Za-z_]\w*)(?:\[(\d+)\])?$/;

export interface Resolved {
  value: unknown;
  error: string | null;
}

export function resolveRef(text: string, bindings: Record<string, string[]>): Resolved {
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
  if (typeof value === 'string') {
    const m = REF.exec(value);
    if (m && m[1] !== undefined && !defined.has(m[1])) return `references undefined alias $${m[1]}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const e = findUndefinedRef(item, defined);
      if (e) return e;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const e = findUndefinedRef(v, defined);
      if (e) return e;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isPlanAction(value: unknown): value is PlanAction {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { command?: unknown }).command === 'string'
  );
}

export function isRepeatStep(value: unknown): value is RepeatStep {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['repeat'] === 'object' &&
    v['repeat'] !== null &&
    typeof v['step'] === 'object' &&
    v['step'] !== null &&
    typeof (v['step'] as Record<string, unknown>)['command'] === 'string'
  );
}

export function isForEachStep(value: unknown): value is ForEachStep {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['for_each'] === 'object' &&
    v['for_each'] !== null &&
    typeof v['step'] === 'object' &&
    v['step'] !== null &&
    typeof (v['step'] as Record<string, unknown>)['command'] === 'string'
  );
}

export function budgetFailure(index: number): StepReport {
  return {
    index,
    command: 'build_project',
    ok: false,
    summary: `step budget exceeded: MAX_PROJECT_STEPS (${MAX_PROJECT_STEPS}).`,
    affected: [],
  };
}

export function noop(doc: CadDocument, data: BuildProjectData, summary: string): CommandResult {
  return { document: doc, summary, affected: [], data };
}

/**
 * Build an expression env from doc.parameters plus loop bindings ($i, $as, etc.).
 * Only numeric parameter values are included (expressions are already evaluated on the Parameter).
 */
export function buildEnv(doc: CadDocument, extras: Record<string, number>): Record<string, number> {
  const env: Record<string, number> = {};
  for (const [name, param] of Object.entries(doc.parameters)) {
    env[name] = param.value;
  }
  for (const [k, v] of Object.entries(extras)) {
    env[k] = v;
  }
  return env;
}

/**
 * Resolve a count value: number literal or expression string (prefix `=`).
 * Expression is evaluated against doc.parameters.
 */
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
 * Resolve a `for_each` values entry: array literal or expression string.
 * Expression must evaluate to a number; we wrap a single number as a one-element array,
 * or if the expression is a param name pointing to an array stored in the doc this is
 * handled via a special array-params lookup (doc.parameters only holds numbers for now,
 * so we fall back to evaluating the expression as a number and wrapping it).
 *
 * Full array support: if `values` is already an array we use it directly.
 * String form: if the doc has a `parameters` entry with that name, treat it as a
 * series (the value itself is a number — wrap it). Otherwise evaluate as arithmetic
 * and wrap.
 */
export function resolveForEachValues(
  raw: unknown[] | string,
  doc: CadDocument,
): { values: unknown[]; error: string | null } {
  if (Array.isArray(raw)) return { values: raw, error: null };
  // String expression form.
  const expr = raw.startsWith('=') ? raw.slice(1) : raw;
  const env = buildEnv(doc, {});
  const result = evaluateExpression(expr, env);
  if (!result.ok) return { values: [], error: `for_each values expression error: ${result.error}` };
  // A scalar expression wraps into a single-element array.
  return { values: [result.value], error: null };
}

/**
 * Resolve expression strings inside params when `$i` / `$as_name` numeric extras are available.
 * Expression strings are prefixed with `=`. Non-expression strings are passed through the
 * existing $alias resolver first, then checked for `=` prefix.
 */
export function resolveExprInParam(
  value: unknown,
  bindings: Record<string, string[]>,
  env: Record<string, number>,
): Resolved {
  if (typeof value === 'string') {
    // First try $alias resolution.
    if (REF.test(value)) return resolveRef(value, bindings);
    // Then try expression (= prefix).
    if (value.startsWith('=')) {
      // Inside an expression body, `$name` references the loop variable as a
      // numeric value (e.g. `=$r * 2`). Strip the `$` so the expression parser
      // sees the bare identifier — which is what env binds.
      const expr = value.slice(1).replace(/\$([A-Za-z_]\w*)/g, '$1');
      const r = evaluateExpression(expr, env);
      if (!r.ok) return { value: undefined, error: `expression "${expr}": ${r.error}` };
      return { value: r.value, error: null };
    }
    return { value, error: null };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const r = resolveExprInParam(item, bindings, env);
      if (r.error) return r;
      out.push(r.value);
    }
    return { value: out, error: null };
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveExprInParam(v, bindings, env);
      if (r.error) return r;
      out[k] = r.value;
    }
    return { value: out, error: null };
  }
  return { value, error: null };
}

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
