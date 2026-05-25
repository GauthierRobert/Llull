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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanAction {
  command: string;
  params?: Record<string, unknown>;
  as?: string;
}

interface BuildProjectParams {
  actions: PlanAction[];
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

/** Recursively resolve every `$alias` reference inside a params value. */
function resolveDeep(value: unknown, bindings: Record<string, string[]>): Resolved {
  if (typeof value === 'string') return resolveRef(value, bindings);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const r = resolveDeep(item, bindings);
      if (r.error) return r;
      out.push(r.value);
    }
    return { value: out, error: null };
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveDeep(v, bindings);
      if (r.error) return r;
      out[k] = r.value;
    }
    return { value: out, error: null };
  }
  return { value, error: null };
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

function noop(doc: CadDocument, data: BuildProjectData, summary: string): CommandResult {
  return { document: doc, summary, affected: [], data };
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
    'Apply an ordered list of command actions as one project. Each action is ' +
    '{ command, params, as? }. A step may bind its result to an alias with "as", and a later ' +
    'step may reference the created entity id as "$alias" (first affected id) or "$alias[N]" (Nth) ' +
    'inside its params. onError="abort" (default) rolls the whole document back on the first ' +
    'failing step; "continue" applies what it can. validate=true performs a dry run (checks ' +
    'commands, required params and alias references) without changing the document. The result ' +
    'data field carries a per-step report and the final scene snapshot.',
  paramsSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description:
          'Ordered list of actions to apply. Each item is an object with "command" (a registered ' +
          'tool name), optional "params" (that command\'s parameters; values may contain "$alias" ' +
          'references to earlier steps), and optional "as" (bind this step\'s result to an alias).',
        items: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Registered command/tool name to run, e.g. "add_box".' },
            params: { type: 'object', description: 'Parameters for the command. May reference earlier steps via "$alias".' },
            as: { type: 'string', description: 'Optional alias bound to this step\'s affected ids for later "$alias" references.' },
          },
        },
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
        if (!isPlanAction(raw)) {
          issues.push(`step ${i}: not a valid action (needs a string "command")`);
          return;
        }
        const def = getCommand(raw.command);
        const params = raw.params ?? {};
        if (!def) {
          issues.push(`step ${i} (${raw.command}): unknown command`);
          // Unknown command can never bind ids — do NOT register its alias, so a
          // later "$alias" ref to it is correctly flagged (mirrors run-mode behavior).
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
      const resolved = resolveDeep(raw.params ?? {}, bindings);
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
