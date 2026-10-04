/**
 * Parameter-expression resolution and id remapping for the regeneration pass: string params
 * starting with `=` are expressions resolved against `doc.parameters`; a failing one keeps its
 * `=expr` text and is reported in `ResolveResult.errors` (never throws).
 *
 * @layer core/commands
 * @pure
 */

import type { Parameter } from '../model/types';
import { evaluateExpression } from './expression';

/** One failed `=expr` substitution: `path` like `size[0]`, the original `expression`, the `reason`. */
interface ResolveError {
  readonly path: string;
  readonly expression: string;
  readonly reason: string;
}

/** Outcome of resolving a step's params against the current parameter environment. */
interface ResolveResult {
  /** Params with every resolvable `=expr` replaced by its numeric value. */
  readonly resolved: unknown;
  readonly errors: readonly ResolveError[];
}

/** Parameter name → value, skipping parameters in error (stale values). @pure */
export function buildParamEnv(
  parameters: Readonly<Record<string, Parameter>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(parameters)
      .filter(([, param]) => !param.error)
      .map(([name, param]) => [name, param.value]),
  );
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

/** Every string leaf of `value` (arrays and plain objects walked recursively). */
export function stringLeaves(value: unknown): string[] {
  const leaves: string[] = [];
  mapStringLeaves(value, (text) => {
    leaves.push(text);
    return text;
  });
  return leaves;
}

/** Resolve `=expr` strings in a step's params against `env`; `params` is not mutated. @pure */
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
 * Replace every string in `params` that is a key of `idMap` with its mapped id (stale entity-id
 * references after earlier steps minted new ids). Blind walk: no per-command id-param allowlist.
 * @pure
 */
export function remapIds(params: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (idMap.size === 0) return params;
  return mapStringLeaves(params, (text) => idMap.get(text) ?? text);
}

/** Record `recorded[i] -> replayed[i]` in `idMap` wherever they differ (common prefix only). */
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
