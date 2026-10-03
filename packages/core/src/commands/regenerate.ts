/**
 * Parameter-expression resolution and id remapping for the regeneration pass.
 *
 * When a feature step's params contain strings that begin with `=`, those are
 * treated as parameter expressions and resolved against `doc.parameters` before
 * the step's command is executed. Non-`=` values pass through unchanged.
 *
 * Convention: `"=width*2"` strips the leading `=` and evaluates `"width*2"` via
 * the expression evaluator. On error (parse failure, missing reference) the
 * original `=expr` string is kept and the error is recorded in the returned
 * `ResolveResult.errors` array — the step is still run with whatever params could
 * be resolved (graceful degradation, never throws).
 *
 * @layer core/commands
 * @pure — every exported function is stateless and side-effect-free.
 */

import type { Parameter } from '../model/types';
import { evaluateExpression } from './expression';

/** A single expression-substitution failure. */
interface ResolveError {
  /** The path to the key that failed, e.g. `"size[0]"` or `"radius"`. */
  readonly path: string;
  /** The original `=expr` string (including the leading `=`). */
  readonly expression: string;
  /** The reason evaluation failed. */
  readonly reason: string;
}

/** Outcome of resolving a step's params against the current parameter environment. */
interface ResolveResult {
  /** Params with all resolvable `=expr` strings replaced by their numeric values. */
  readonly resolved: unknown;
  /** One entry for each `=expr` that could not be evaluated. */
  readonly errors: readonly ResolveError[];
}

/**
 * Flat `env` map of parameter name → numeric value, skipping any parameter that has an
 * `error` (its value is stale and unreliable as a dependency).
 *
 * @pure
 */
export function buildParamEnv(
  parameters: Readonly<Record<string, Parameter>>,
): Readonly<Record<string, number>> {
  const env: Record<string, number> = {};
  for (const [name, param] of Object.entries(parameters)) {
    if (!param.error) {
      env[name] = param.value;
    }
  }
  return env;
}

/**
 * Rebuild `value` with every STRING leaf replaced by `mapLeaf(text, path)`; arrays and plain
 * objects are walked recursively, other primitives pass through. `path` is `size[0]` / `a.b` style.
 *
 * @pure
 * @invariant `value` is never mutated; new objects/arrays are always returned.
 */
export function mapStringLeaves(
  value: unknown,
  mapLeaf: (text: string, path: string) => unknown,
  path = '',
): unknown {
  if (typeof value === 'string') return mapLeaf(value, path);
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      mapStringLeaves(item, mapLeaf, path ? `${path}[${i}]` : `[${i}]`),
    );
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = mapStringLeaves(val, mapLeaf, path ? `${path}.${key}` : key);
    }
    return result;
  }
  return value;
}

/**
 * Resolve `=expr` strings in a step's params against `env`. A failed expression keeps its
 * original string and is pushed to `errors`; the function never throws.
 *
 * @pure
 * @invariant `params` is never mutated; a new object/array is always returned.
 */
export function resolveStepParams(
  params: unknown,
  env: Readonly<Record<string, number>>,
): ResolveResult {
  const errors: ResolveError[] = [];
  const resolved = mapStringLeaves(params, (text, path) => {
    if (!text.startsWith('=')) return text;
    const result = evaluateExpression(text.slice(1), env);
    if (result.ok) return result.value;
    errors.push({ path, expression: text, reason: result.error });
    return text;
  });
  return { resolved, errors };
}

/**
 * Replace any STRING value in `params` that is a key in `idMap` with the mapped value
 * (rewrites stale entity-id references after earlier steps produced new ids).
 *
 * @pure
 * @invariant `params` is never mutated; new objects/arrays are always returned.
 */
export function remapIds(params: unknown, idMap: ReadonlyMap<string, string>): unknown {
  // Blind walk (no per-command id-param allowlist): a free-text param equal to a prior
  // id (`prefix-base36-base36`) would be rewritten, but such a collision is astronomically
  // unlikely. If it ever matters, add an id-param-path allowlist.
  if (idMap.size === 0) return params;
  return mapStringLeaves(params, (text) => idMap.get(text) ?? text);
}

/**
 * Positional id-remap: record `recorded[i] -> replayed[i]` in `idMap` for every index where the
 * two ids differ (a recorded step's `affected` zipped with the replayed result's `affected`).
 *
 * @invariant undefined/shorter/longer lists zip over the common prefix only
 */
export function extendIdMap(
  idMap: Map<string, string>,
  recorded: readonly string[] | undefined,
  replayed: readonly string[],
): void {
  if (!recorded) return;
  const len = Math.min(recorded.length, replayed.length);
  for (let i = 0; i < len; i++) {
    const oldId = recorded[i];
    const newId = replayed[i];
    if (oldId !== undefined && newId !== undefined && oldId !== newId) idMap.set(oldId, newId);
  }
}
