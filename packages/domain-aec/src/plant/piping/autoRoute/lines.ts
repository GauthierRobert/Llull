/**
 * Several lines in one transaction (02 RTE V2, §13.12): the routing order and the bounded retry. Lines are routed one after the other on a
 * working copy of the document, so each routed run is an obstacle for the next (the clash bodies, `obstacles.ts`); a failure reorders and tries
 * again, up to `maxAttempts` passes.
 *
 * Order rule (`ORDER_RULE`): lines promoted by an earlier failure first (the latest promoted first), then by DN descending (the stiffest, widest
 * lines claim space first), then by straight-line (Manhattan) distance between the two ends descending (the longest, most constrained runs
 * first), then by position in the request. An end that is not a known port counts as distance 0 (its route is refused with the proper code).
 * Retry rule: the first line that fails in a pass, when at least one line was routed before it in that pass, is promoted to the front; a line
 * that fails with nothing routed before it cannot be helped by reordering, and a repeated order ends the retries.
 * @invariant pure and deterministic: the same document and requests give the same attempts, order and ids (run ids are minted once per request)
 */

import type { CadDocument } from '@core/model/types';
import { getPiping } from '../model';
import { resolvePortId } from '../ports';
import type { Endpoint, RouteRequest } from './problem';
import { routeOne } from './routeOne';
import type { RouteSolution } from './solution';

export const ORDER_RULE =
  'promoted lines first; then DN descending, straight-line distance between the ends descending, request position ascending';

/** One line of a transaction. */
export interface LineEntry {
  readonly request: RouteRequest;
  /** Run id minted for the request (the same in every attempt and in the committed document). */
  readonly runId: string;
  readonly maxExpansions?: number | undefined;
  readonly solution?: RouteSolution | undefined;
}

export interface LineOutcome {
  readonly lineId: string;
  readonly status: 'routed' | 'failed' | 'skipped';
  readonly runId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly solution?: RouteSolution;
  readonly problemHash?: string;
}

export interface Attempt {
  /** Line ids in the order tried. */
  readonly order: readonly string[];
  readonly outcomes: readonly LineOutcome[];
  readonly routed: number;
  /** The document after the routed lines of this pass. */
  readonly document: CadDocument;
}

const endpointPoint = (doc: CadDocument, end: Endpoint): readonly [number, number, number] | null => {
  if ('point' in end) return end.point;
  const resolved = resolvePortId(doc, end.portId);
  return resolved.ok ? resolved.port.spec.position : null;
};

/** What the order rule reads of a request: the line DN (0 when unknown) and the Manhattan distance between the two ends, mm (0 when an end is unknown). */
export function lineMetrics(doc: CadDocument, request: RouteRequest): { dn: number; distanceMm: number } {
  const [a, b] = [endpointPoint(doc, request.from), endpointPoint(doc, request.to)];
  return {
    dn: getPiping(doc).lines[request.lineId]?.dn ?? 0,
    distanceMm: a === null || b === null ? 0 : Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]),
  };
}

/** Indices of `requests` in routing order (`ORDER_RULE`); `promoted` = line ids moved to the front, the latest first. */
export function routingOrder(doc: CadDocument, requests: readonly RouteRequest[], promoted: readonly string[]): number[] {
  const rank = (request: RouteRequest): number => {
    const at = promoted.indexOf(request.lineId);
    return at < 0 ? promoted.length : at;
  };
  const keyed = requests.map((request, index) => ({ index, rank: rank(request), ...lineMetrics(doc, request) }));
  return keyed
    .sort((a, b) => a.rank - b.rank || b.dn - a.dn || b.distanceMm - a.distanceMm || a.index - b.index)
    .map((entry) => entry.index);
}

/**
 * One pass over `order` (indices of `entries`). With `continueAfterFailure` a failed line is skipped and the pass goes on; otherwise it stops
 * and the rest are `skipped`.
 */
export function runPass(doc: CadDocument, entries: readonly LineEntry[], order: readonly number[], continueAfterFailure: boolean): Attempt {
  let current = doc;
  let stopped = false;
  const outcomes: LineOutcome[] = [];
  for (const index of order) {
    const entry = entries[index] as LineEntry;
    const lineId = entry.request.lineId;
    if (stopped) {
      outcomes.push({ lineId, status: 'skipped' });
      continue;
    }
    const routed = routeOne(current, entry.request, { runId: entry.runId, maxExpansions: entry.maxExpansions, solution: entry.solution });
    if (routed.ok) {
      current = routed.document;
      outcomes.push({ lineId, status: 'routed', runId: routed.runId, solution: routed.solution, problemHash: routed.problemHash });
    } else {
      outcomes.push({ lineId, status: 'failed', code: routed.code, message: routed.message });
      stopped = !continueAfterFailure;
    }
  }
  // Lines left out of an explicit sequence are not tried.
  entries.forEach((entry, index) => {
    if (!order.includes(index)) outcomes.push({ lineId: entry.request.lineId, status: 'skipped' });
  });
  return {
    order: order.map((index) => (entries[index] as LineEntry).request.lineId),
    outcomes,
    routed: outcomes.filter((outcome) => outcome.status === 'routed').length,
    document: current,
  };
}

export interface TransactionOptions {
  readonly order: 'auto' | 'given';
  readonly partial: boolean;
  readonly maxAttempts: number;
  /** With order 'given': the line ids to route, in this order (default: every line, in the request order). Lines left out are skipped. */
  readonly sequence?: readonly string[] | undefined;
}

export interface Transaction {
  /** Every pass tried, in order. */
  readonly attempts: readonly Attempt[];
  /** The pass whose document is committed: the first that routed every line, else the one that routed most (the earliest on ties). */
  readonly best: Attempt;
  readonly complete: boolean;
}

const givenOrder = (requests: readonly RouteRequest[], sequence: readonly string[] | undefined): number[] =>
  sequence === undefined ? requests.map((_, index) => index) : sequence.map((id) => requests.findIndex((request) => request.lineId === id));

/**
 * Passes in the rule's order, reordering after failures (see the module comment).
 * @failure none: a line that cannot be routed is an outcome of the pass, never an exception
 */
export function routeTransaction(doc: CadDocument, entries: readonly LineEntry[], options: TransactionOptions): Transaction {
  const requests = entries.map((entry) => entry.request);
  const attempts: Attempt[] = [];
  const promoted: string[] = [];
  const tried = new Set<string>();
  const limit = options.order === 'given' ? 1 : options.maxAttempts;
  while (attempts.length < limit) {
    const order = options.order === 'given' ? givenOrder(requests, options.sequence) : routingOrder(doc, requests, promoted);
    const key = order.join(',');
    if (tried.has(key)) break;
    tried.add(key);
    const pass = runPass(doc, entries, order, options.partial);
    attempts.push(pass);
    if (pass.routed === entries.length) break;
    const firstFailure = pass.outcomes.findIndex((outcome) => outcome.status === 'failed');
    const failed = pass.outcomes[firstFailure];
    if (failed === undefined || !pass.outcomes.slice(0, firstFailure).some((outcome) => outcome.status === 'routed')) break;
    promoted.unshift(failed.lineId);
  }
  const best = attempts.reduce((top, pass) => (pass.routed > top.routed ? pass : top), attempts[0] as Attempt);
  return { attempts, best, complete: best.routed === entries.length };
}
