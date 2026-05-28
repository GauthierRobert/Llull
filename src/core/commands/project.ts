/**
 * build_project — execute an AI-authored plan (an ordered list of command
 * actions) as one transaction.
 *
 * @layer core/commands
 *
 * This is the headline MCP capability: an agent describes a whole project as a
 * list of actions and applies it in a single round-trip. It does NOT bypass the
 * command layer — it routes every step through `execute` (the Prime Directive
 * choke point). Adding it to the registry made it one undoable step in the UI
 * and one MCP tool, like any other command.
 *
 * Cross-step references: a step may bind its result to an alias via `as`, and a
 * later step may reference the created id with `$alias` (first affected id) or
 * `$alias[N]` (Nth). This lets an agent author a multi-step plan without knowing
 * generated ids in advance — e.g. create a box `as: "base"`, then `move` `$base`.
 *
 * `onError: "abort"` (default) rolls the document fully back on the first failing
 * step (commands are pure, so the original doc is simply returned). `"continue"`
 * keeps going, recording per-step status. `validate: true` is a dry run: it
 * checks every step (command exists, required params present, alias refs defined)
 * without mutating the document.
 *
 * The result `data` carries a per-step report plus the final SceneSnapshot, so an
 * agent sees the whole outcome in one call.
 */

import type { CadDocument } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { execute, getCommand } from './registry';
import { computeSceneSnapshot, type SceneSnapshot } from './scene';
import { evaluateExpression } from './expression';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanAction {
  command: string;
  params?: Record<string, unknown>;
  as?: string;
}

/**
 * A `repeat` step runs an inner step `count` times.
 * `count` may be a number literal or an expression string (prefix `=`).
 * Each iteration exposes `$i` (0-indexed) in params expressions.
 * `as` (if provided) is bound to the last iteration's affected ids.
 */
interface RepeatStep {
  repeat: {
    count: number | string;
    as?: string;
  };
  step: { command: string; params?: Record<string, unknown> };
}

/**
 * A `for_each` step iterates over an array of values.
 * `values` may be an array literal or an expression string resolving to an array.
 * Each iteration exposes `$as` (current element) and `$i` (0-indexed index).
 */
interface ForEachStep {
  for_each: {
    values: unknown[] | string;
    as: string;
  };
  step: { command: string; params?: Record<string, unknown> };
}

/** A top-level action item — either a plain action or a control-flow step. */
type ActionItem = PlanAction | RepeatStep | ForEachStep;

interface BuildProjectParams {
  actions: ActionItem[];
  onError?: 'abort' | 'continue';
  validate?: boolean;
}

interface StepReport {
  index: number;
  command: string;
  ok: boolean;
  summary: string;
  affected: string[];
}

interface BuildProjectData {
  ok: boolean;
  validated: boolean;
  stepCount: number;
  steps: StepReport[];
  /** Index of the step that aborted the run, or null (completed / continue mode). */
  failedAt: number | null;
  /** Validation issues (validate mode only). */
  issues?: string[];
  /** Final document snapshot (omitted in validate mode — nothing changed). */
  scene?: SceneSnapshot;
}

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

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
    return { value: undefined, error: `alias $${name} has no id at index ${index} (bound ${ids.length})` };
  }
  return { value: id, error: null };
}

/** Validate-mode walk: every `$alias` ref must name an alias defined by an earlier step. */
function findUndefinedRef(value: unknown, defined: ReadonlySet<string>): string | null {
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

function isPlanAction(value: unknown): value is PlanAction {
  return typeof value === 'object' && value !== null && typeof (value as { command?: unknown }).command === 'string';
}

function isRepeatStep(value: unknown): value is RepeatStep {
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

function isForEachStep(value: unknown): value is ForEachStep {
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

function noop(doc: CadDocument, data: BuildProjectData, summary: string): CommandResult {
  return { document: doc, summary, affected: [], data };
}

/**
 * Build an expression env from doc.parameters plus loop bindings ($i, $as, etc.).
 * Only numeric parameter values are included (expressions are already evaluated on the Parameter).
 */
function buildEnv(doc: CadDocument, extras: Record<string, number>): Record<string, number> {
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
function resolveCount(raw: number | string, doc: CadDocument): { count: number; error: string | null } {
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
function resolveForEachValues(raw: unknown[] | string, doc: CadDocument): { values: unknown[]; error: string | null } {
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
function resolveExprInParam(
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
 * Execute a single inner step (for repeat/for_each bodies) against the current doc.
 * Returns { doc, stepReport, aborted } where aborted=true means the caller should stop.
 */
function runInnerStep(
  stepDef: { command: string; params?: Record<string, unknown> },
  current: CadDocument,
  bindings: Record<string, string[]>,
  env: Record<string, number>,
  stepLabel: string,
  steps: StepReport[],
  allAffected: string[],
  onError: 'abort' | 'continue',
  outerIndex: number,
): { doc: CadDocument; affected: string[]; aborted: boolean } {
  const { command, params = {} } = stepDef;

  if (!getCommand(command)) {
    steps.push({ index: outerIndex, command, ok: false, summary: `Unknown command: ${command} (${stepLabel})`, affected: [] });
    return { doc: current, affected: [], aborted: onError === 'abort' };
  }

  const resolved = resolveExprInParam(params, bindings, env);
  if (resolved.error) {
    steps.push({ index: outerIndex, command, ok: false, summary: `Param error in ${stepLabel}: ${resolved.error}`, affected: [] });
    return { doc: current, affected: [], aborted: onError === 'abort' };
  }

  const result = execute(current, command, resolved.value);
  const ok = result.affected.length > 0 || result.document !== current;
  steps.push({ index: outerIndex, command, ok, summary: `${stepLabel}: ${result.summary}`, affected: result.affected });

  if (ok) {
    allAffected.push(...result.affected);
    return { doc: result.document, affected: result.affected, aborted: false };
  }
  return { doc: current, affected: [], aborted: onError === 'abort' };
}

// ---------------------------------------------------------------------------
// build_project command
// ---------------------------------------------------------------------------

/**
 * @command build_project
 * @pure
 * @layer core/commands
 * @affects runs an ordered list of commands; affected = union of created/changed ids
 * @invariant onError:'abort' on failure returns the input doc unchanged (full rollback)
 * @failure empty/invalid actions -> no-op, affected:[]; validate:true never mutates
 */
export const buildProject: CommandDefinition<BuildProjectParams> = {
  name: 'build_project',
  description:
    'Apply an ordered list of command actions as one project. Each action is one of: ' +
    '(1) { command, params, as? } — plain action; ' +
    '(2) { repeat: { count, as? }, step: { command, params } } — run step N times; ' +
    'count may be a number or expression string. Each iteration exposes $i (0-based) in params expressions. ' +
    '(3) { for_each: { values, as }, step: { command, params } } — iterate over values array (or expression). ' +
    '$as is the current element, $i the index. ' +
    'A step may bind its result to an alias with "as"; later steps reference it as "$alias" or "$alias[N]". ' +
    'params values starting with "=" are evaluated as arithmetic expressions against doc.parameters plus $i/$as. ' +
    'onError="abort" (default) rolls the whole document back on the first failing step; "continue" applies what it can. ' +
    'validate=true performs a dry run without changing the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description:
          'Ordered list of actions. Each item is { command, params?, as? } OR ' +
          '{ repeat: { count, as? }, step: { command, params? } } OR ' +
          '{ for_each: { values, as }, step: { command, params? } }. ' +
          'Params values may be "$alias" references or "=expr" arithmetic expressions.',
        items: { type: 'object' },
      },
      onError: {
        type: 'string',
        description: 'Failure policy: "abort" (default, full rollback on first failure) or "continue".',
        enum: ['abort', 'continue'],
      },
      validate: {
        type: 'boolean',
        description: 'When true, dry-run only: validate every step without modifying the document.',
      },
    },
    required: ['actions'],
  },
  run: (doc, { actions, onError = 'abort', validate = false }): CommandResult => {
    if (!Array.isArray(actions) || actions.length === 0) {
      return noop(doc, { ok: false, validated: validate, stepCount: 0, steps: [], failedAt: null }, 'build_project: no actions provided.');
    }

    if (validate) {
      const defined = new Set<string>();
      const issues: string[] = [];
      actions.forEach((raw, i) => {
        if (isRepeatStep(raw) || isForEachStep(raw)) {
          // Basic structural validation for control-flow steps.
          defined.add(
            isRepeatStep(raw) ? (raw.repeat.as ?? '') : raw.for_each.as,
          );
          return; // deeper validation of inner step expressions deferred to run-time
        }
        if (!isPlanAction(raw)) {
          issues.push(`step ${i}: not a valid action (needs a string "command")`);
          return;
        }
        const def = getCommand(raw.command);
        const params = raw.params ?? {};
        if (!def) {
          issues.push(`step ${i} (${raw.command}): unknown command`);
          return;
        }
        for (const req of def.paramsSchema.required) {
          if (!(req in params)) issues.push(`step ${i} (${raw.command}): missing required param "${req}"`);
        }
        const refErr = findUndefinedRef(params, defined);
        if (refErr) issues.push(`step ${i} (${raw.command}): ${refErr}`);
        if (raw.as) defined.add(raw.as);
      });
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

    const bindings: Record<string, string[]> = {};
    const steps: StepReport[] = [];
    const allAffected: string[] = [];
    let current = doc;
    let failedAt: number | null = null;

    for (let i = 0; i < actions.length; i++) {
      const raw = actions[i];

      // ── repeat ──────────────────────────────────────────────────────────
      if (isRepeatStep(raw)) {
        const countResult = resolveCount(raw.repeat.count, current);
        if (countResult.error !== null) {
          steps.push({ index: i, command: 'repeat', ok: false, summary: countResult.error, affected: [] });
          if (onError === 'abort') { failedAt = i; break; }
          continue;
        }
        const count = Math.round(countResult.count);
        if (count < 0) {
          steps.push({ index: i, command: 'repeat', ok: false, summary: `repeat: count must be >= 0 (got ${count}).`, affected: [] });
          if (onError === 'abort') { failedAt = i; break; }
          continue;
        }
        let loopAffected: string[] = [];
        let aborted = false;
        for (let iter = 0; iter < count; iter++) {
          const env = buildEnv(current, { i: iter });
          const r = runInnerStep(
            raw.step, current, bindings, env,
            `repeat[${iter}]`, steps, allAffected, onError, i,
          );
          current = r.doc;
          loopAffected = r.affected;
          if (r.aborted) { aborted = true; break; }
        }
        if (aborted) { failedAt = i; break; }
        if (raw.repeat.as) bindings[raw.repeat.as] = loopAffected;
        continue;
      }

      // ── for_each ────────────────────────────────────────────────────────
      if (isForEachStep(raw)) {
        const valResult = resolveForEachValues(raw.for_each.values, current);
        if (valResult.error !== null) {
          steps.push({ index: i, command: 'for_each', ok: false, summary: valResult.error, affected: [] });
          if (onError === 'abort') { failedAt = i; break; }
          continue;
        }
        if (!Array.isArray(valResult.values)) {
          steps.push({ index: i, command: 'for_each', ok: false, summary: 'for_each: values did not resolve to an array.', affected: [] });
          if (onError === 'abort') { failedAt = i; break; }
          continue;
        }
        const alias = raw.for_each.as;
        let loopAffected: string[] = [];
        let aborted = false;
        for (let iter = 0; iter < valResult.values.length; iter++) {
          const elem = valResult.values[iter];
          // Inject $i and, if elem is numeric, $as as a number for expression resolution.
          const extras: Record<string, number> = { i: iter };
          if (typeof elem === 'number') extras[alias] = elem;
          const env = buildEnv(current, extras);
          // Also expose $alias as a string binding pointing to a numeric string for $alias refs.
          const iterBindings: Record<string, string[]> = {
            ...bindings,
            [alias]: [String(elem)],
          };
          const r = runInnerStep(
            raw.step, current, iterBindings, env,
            `for_each[${iter}]`, steps, allAffected, onError, i,
          );
          current = r.doc;
          loopAffected = r.affected;
          if (r.aborted) { aborted = true; break; }
        }
        if (aborted) { failedAt = i; break; }
        bindings[alias] = loopAffected;
        continue;
      }

      // ── plain action ────────────────────────────────────────────────────
      if (!isPlanAction(raw)) {
        steps.push({ index: i, command: '(invalid)', ok: false, summary: 'Not a valid action.', affected: [] });
        if (onError === 'abort') { failedAt = i; break; }
        continue;
      }
      if (!getCommand(raw.command)) {
        steps.push({ index: i, command: raw.command, ok: false, summary: `Unknown command: ${raw.command}`, affected: [] });
        if (onError === 'abort') { failedAt = i; break; }
        continue;
      }
      const env = buildEnv(current, {});
      const resolved = resolveExprInParam(raw.params ?? {}, bindings, env);
      if (resolved.error) {
        steps.push({ index: i, command: raw.command, ok: false, summary: `Param error: ${resolved.error}`, affected: [] });
        if (onError === 'abort') { failedAt = i; break; }
        continue;
      }
      const result = execute(current, raw.command, resolved.value);
      // A graceful no-op (no change + nothing affected) is a soft failure for a plan step.
      const ok = result.affected.length > 0 || result.document !== current;
      steps.push({ index: i, command: raw.command, ok, summary: result.summary, affected: result.affected });
      if (ok) {
        current = result.document;
        allAffected.push(...result.affected);
        if (raw.as) bindings[raw.as] = result.affected;
      } else if (onError === 'abort') {
        failedAt = i;
        break;
      }
    }

    const aborted = failedAt !== null;
    const finalDoc = aborted ? doc : current;
    const affected = aborted ? [] : allAffected;
    const allOk = !aborted && steps.every((s) => s.ok);
    const scene = computeSceneSnapshot(finalDoc);

    let summary: string;
    if (failedAt !== null) {
      const f = steps[failedAt];
      summary = `Plan aborted at step ${failedAt} (${f?.command ?? '?'}): ${f?.summary ?? ''} — rolled back, document unchanged.`;
    } else {
      const okCount = steps.filter((s) => s.ok).length;
      summary = `Plan complete: ${okCount}/${actions.length} step(s) ok, ${affected.length} entit${affected.length === 1 ? 'y' : 'ies'} affected.`;
    }

    return {
      document: finalDoc,
      summary,
      affected,
      data: { ok: allOk, validated: false, stepCount: actions.length, steps, failedAt, scene },
    };
  },
};
