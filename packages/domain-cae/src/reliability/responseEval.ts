/** Evaluates responses (a scalar read from a read-only registry command) at parameter values by running registry commands on an in-memory document. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { Response } from '@cae/reliability/types';

type Query = Response['query'];

/** Cap on registry evaluations (each regenerates the feature history) of one response-backed study. */
export const MAX_RESPONSE_EVALUATIONS = 20_000;

/** Value at an RFC 6901 JSON `pointer` ('/data/mass', '/data/items/0/value'), or undefined when it does not resolve. */
export function pointerTarget(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined;
  let node: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export type QueryValue = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string };

/**
 * Run the response query on `doc` and read its number; the pointer applies to `{ summary, affected, data }` of the command result.
 * @failure command refused / not a query / pointer not a finite number -> { ok: false, reason }
 */
export function queryValue(doc: CadDocument, query: Query, ctx: ExecutionContext | undefined): QueryValue {
  const result = execute(doc, query.command, query.params, ctx);
  if (result.error !== undefined) return { ok: false, reason: `${query.command} refused: ${result.summary}` };
  const value = pointerTarget({ summary: result.summary, affected: result.affected, data: result.data }, query.pointer);
  return typeof value === 'number' && Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, reason: `${query.command}: pointer '${query.pointer}' is not a finite number in its result` };
}

/** A copy of `doc` with the parameters set to the given values (set_parameter, so dependents and geometry regenerate); null when one is refused. */
export function withParameters(
  doc: CadDocument,
  values: Readonly<Record<string, number>>,
  ctx: ExecutionContext | undefined,
): CadDocument | null {
  let current = doc;
  for (const [name, value] of Object.entries(values)) {
    current = execute(current, 'set_parameter', { name, expression: String(value) }, ctx).document;
    if (!Object.hasOwn(current.parameters, name) || current.parameters[name]?.value !== value) return null;
  }
  return current;
}
