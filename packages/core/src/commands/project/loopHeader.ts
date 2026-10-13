/**
 * Header resolution of nestable loops (`{ repeat | for, actions }`): variable name and the list of values to iterate, evaluated over the
 * document parameters and the enclosing loop variables.
 */

import { evaluateExpression } from '../parametric/expression';
import { MAX_LOOP_ITERATIONS } from '../limits';
import { isRecord } from '../../lib/isRecord';
import { type LoopNode } from './types';

const IDENT = /^[A-Za-z_]\w*$/;

/** `{ repeat | for, actions: [...] }` — the nestable loop form (legacy loops use `step`). */
export function isLoopNode(value: unknown): value is LoopNode {
  return isRecord(value) && Array.isArray(value['actions']) && (isRecord(value['repeat']) || isRecord(value['for']));
}

function evaluate(raw: unknown, env: Record<string, number>, what: string): number | string {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : `${what} must be a finite number`;
  if (typeof raw !== 'string') return `${what} must be a number or an "=expr" string`;
  const result = evaluateExpression(raw.startsWith('=') ? raw.slice(1) : raw, env);
  if (!result.ok) return `${what} expression "${raw}": ${result.error}`;
  return Number.isFinite(result.value) ? result.value : `${what} "${raw}" is not finite`;
}

/** Loop variable name and the ordered values it takes; `error` set means the loop cannot run. */
export interface LoopHeader {
  readonly variable: string;
  readonly values: readonly number[];
  readonly error: string | null;
}

const failure = (variable: string, error: string): LoopHeader => ({ variable, values: [], error });

function resolveRepeat(spec: NonNullable<LoopNode['repeat']>, env: Record<string, number>): LoopHeader {
  const variable = spec.as ?? 'i';
  if (!IDENT.test(variable)) return failure(variable, `repeat.as "${variable}" is not a valid name`);
  const count = evaluate(spec.count, env, 'repeat.count');
  if (typeof count === 'string') return failure(variable, count);
  if (!Number.isInteger(count) || count < 0) return failure(variable, `repeat.count must be a non-negative integer (got ${count})`);
  if (count > MAX_LOOP_ITERATIONS) return failure(variable, `repeat.count ${count} exceeds MAX_LOOP_ITERATIONS (${MAX_LOOP_ITERATIONS})`);
  return { variable, values: Array.from({ length: count }, (_, k) => k), error: null };
}

function resolveFor(spec: NonNullable<LoopNode['for']>, env: Record<string, number>): LoopHeader {
  const variable = typeof spec.var === 'string' ? spec.var : '';
  if (!IDENT.test(variable)) return failure(variable, `for.var "${variable}" is not a valid name`);
  const from = evaluate(spec.from, env, 'for.from');
  if (typeof from === 'string') return failure(variable, from);
  const to = evaluate(spec.to, env, 'for.to');
  if (typeof to === 'string') return failure(variable, to);
  const step = spec.step === undefined ? 1 : evaluate(spec.step, env, 'for.step');
  if (typeof step === 'string') return failure(variable, step);
  if (step === 0) return failure(variable, 'for.step must not be 0');
  const length = Math.floor((to - from) / step + 1e-9) + 1;
  if (length > MAX_LOOP_ITERATIONS) return failure(variable, `for loop of ${length} iterations exceeds MAX_LOOP_ITERATIONS`);
  const values = Array.from({ length: Math.max(0, length) }, (_, k) => from + k * step);
  return { variable, values, error: null };
}

/**
 * @failure bad/unknown variable, non-integer or negative `repeat.count`, zero `for.step`, an
 *   unevaluable expression, or more than MAX_LOOP_ITERATIONS values -> `error` set, no values
 */
export function resolveLoopHeader(node: LoopNode, env: Record<string, number>): LoopHeader {
  if (node.repeat !== undefined) return resolveRepeat(node.repeat, env);
  if (node.for !== undefined) return resolveFor(node.for, env);
  return failure('i', 'loop needs "repeat" or "for"');
}
