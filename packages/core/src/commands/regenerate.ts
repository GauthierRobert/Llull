/**
 * Parameter-expression resolution for the constructive→evaluated regeneration pass.
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

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Outcome of resolving a step's params against the current parameter environment.
 *
 * `resolved` is a new params object with `=expr` strings replaced by their
 * numeric values (or left as-is when evaluation failed).
 *
 * `errors` contains one entry per failed expression substitution, carrying
 * enough detail for the caller to surface the failure in the replay summary.
 */
export interface ResolveResult {
  /** Params with all resolvable `=expr` strings replaced by their numeric values. */
  readonly resolved: unknown;
  /** One entry for each `=expr` that could not be evaluated. */
  readonly errors: readonly ResolveError[];
}

/** A single expression-substitution failure. */
export interface ResolveError {
  /** The path to the key that failed, e.g. `"size[0]"` or `"radius"`. */
  readonly path: string;
  /** The original `=expr` string (including the leading `=`). */
  readonly expression: string;
  /** The reason evaluation failed. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a flat `env` map of parameter name → numeric value from the document's
 * `parameters` record, skipping any parameter that has an `error` (its value
 * is stale and unreliable as a dependency).
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
 * Recursively resolve `=expr` strings in a step's params object.
 *
 * Rules:
 * - A string value starting with `=` is treated as an expression: the `=` is
 *   stripped and the remainder is evaluated against `env`. On success the
 *   numeric result replaces the string. On failure the original string is kept
 *   and the error is pushed to `errors`.
 * - All other primitive values (number, boolean, null) pass through unchanged.
 * - Arrays are resolved element-by-element (supports e.g. `position: ["=x", 0, 0]`).
 * - Plain objects are resolved key-by-key recursively.
 * - The function never throws; all failures are accumulated in `errors`.
 *
 * @pure
 * @invariant `params` is never mutated; a new object/array is always returned.
 */
export function resolveStepParams(
  params: unknown,
  env: Readonly<Record<string, number>>,
): ResolveResult {
  const errors: ResolveError[] = [];
  const resolved = resolveValue(params, env, '', errors);
  return { resolved, errors };
}

// ---------------------------------------------------------------------------
// Public API — id remapping
// ---------------------------------------------------------------------------

/**
 * Recursively walk a step's params object/array and replace any STRING value
 * that is a key in `idMap` with the corresponding mapped value.
 *
 * This is used during `replayHistory` to rewrite stale entity-id references
 * in subsequent steps' params after earlier creation steps produced new ids.
 *
 * Rules (mirrors `resolveStepParams`):
 * - A string value that exists as a key in `idMap` is replaced with `idMap[value]`.
 * - All other string values pass through unchanged (non-id strings are safe).
 * - Arrays are walked element-by-element.
 * - Plain objects are walked key-by-key recursively.
 * - Primitives (number, boolean, null, undefined) pass through unchanged.
 * - The function never throws; `params` is never mutated.
 *
 * @pure
 * @invariant `params` is never mutated; new objects/arrays are always returned.
 */
export function remapIds(params: unknown, idMap: ReadonlyMap<string, string>): unknown {
  // Blind walk (no per-command id-param allowlist): a free-text param equal to a prior
  // id (`prefix-base36-base36`) would be rewritten, but such a collision is astronomically
  // unlikely. If it ever matters, add an id-param-path allowlist.
  if (idMap.size === 0) return params;
  return remapValue(params, idMap);
}

// ---------------------------------------------------------------------------
// Internal recursive helpers — remapIds
// ---------------------------------------------------------------------------

function remapValue(value: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const mapped = idMap.get(value);
    return mapped !== undefined ? mapped : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapValue(item, idMap));
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = remapValue(val, idMap);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Internal recursive helpers — resolveStepParams
// ---------------------------------------------------------------------------

function resolveValue(
  value: unknown,
  env: Readonly<Record<string, number>>,
  path: string,
  errors: ResolveError[],
): unknown {
  if (typeof value === 'string') {
    return resolveString(value, env, path, errors);
  }
  if (Array.isArray(value)) {
    return resolveArray(value, env, path, errors);
  }
  if (value !== null && typeof value === 'object') {
    return resolveObject(value as Record<string, unknown>, env, path, errors);
  }
  // number, boolean, null, undefined — pass through.
  return value;
}

function resolveString(
  value: string,
  env: Readonly<Record<string, number>>,
  path: string,
  errors: ResolveError[],
): unknown {
  if (!value.startsWith('=')) {
    return value;
  }
  const expression = value.slice(1); // strip the leading '='
  const result = evaluateExpression(expression, env);
  if (result.ok) {
    return result.value;
  }
  errors.push({ path, expression: value, reason: result.error });
  // Graceful degradation: keep the original `=expr` string so the caller knows
  // which params failed. The step will receive the unresolved string and its
  // command can either handle it or produce its own validation error.
  return value;
}

function resolveArray(
  arr: unknown[],
  env: Readonly<Record<string, number>>,
  path: string,
  errors: ResolveError[],
): unknown[] {
  return arr.map((item, i) => resolveValue(item, env, path ? `${path}[${i}]` : `[${i}]`, errors));
}

function resolveObject(
  obj: Record<string, unknown>,
  env: Readonly<Record<string, number>>,
  path: string,
  errors: ResolveError[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = resolveValue(val, env, path ? `${path}.${key}` : key, errors);
  }
  return result;
}
