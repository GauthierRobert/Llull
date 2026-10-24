/**
 * `auto_route` with `lines` (plant 02 RTE V2, several lines through the native router). Lines depend on each other (each routed run is an
 * obstacle for the next), so the planning runs on a scratch copy of the document: the order comes from the read-only `route_lines_order`, every
 * line is routed with the single-line transport (route_problem -> llull-compute route -> auto_route_pipe { solution }) on the scratch document,
 * and a failure reorders exactly as `auto_route_lines` does (promote the first failed line, bounded passes). The live document is written once,
 * by `auto_route_lines { order: 'given', lines with their solutions }`, which validates every solution against the problem of its turn: the
 * native code and this planner never write the document, and an atomic refusal leaves it as it was.
 */

import type { FeaHost, FeaToolResult } from '@protocol/index';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import type { NativeDeps } from './fatigueField';

const TOOL = 'auto_route';
const DEFAULT_ATTEMPTS = 4;

type Json = Record<string, unknown>;
type SingleRoute = (params: Json, options: LineOptions, host: FeaHost, deps: NativeDeps) => Promise<FeaToolResult>;

export interface LineOptions {
  readonly timeoutS?: number;
  readonly maxExpansions?: number;
}

/** A host on a private copy of the document: commands run through the registry, the live host is never touched. */
function scratchHost(start: CadDocument): FeaHost {
  let doc = start;
  return {
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, defaultContext());
      if (result.rejected !== true) doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
}

const failure = (code: string, message: string, ids: readonly string[] = [], extra: Json = {}): FeaToolResult => ({
  summary: `${TOOL} ${code}: ${message}`,
  affected: [...ids],
  isError: true,
  data: { code, ...extra },
});

/** The RTE_* / NATIVE_* code of a failed single-line result. */
function codeOf(result: FeaToolResult): string {
  const data = isRecord(result.data) ? result.data : {};
  const given = data['code'];
  return typeof given === 'string' ? given : (/\b(?:RTE|NATIVE)_[A-Z_]+\b/.exec(result.summary)?.[0] ?? 'FAILED');
}

interface Planned {
  readonly line: Json;
  readonly solution: Json;
}

interface Pass {
  readonly order: readonly string[];
  readonly planned: readonly Planned[];
  readonly failed: readonly { readonly lineId: string; readonly code: string; readonly summary: string }[];
}

const SOLUTION_KEYS = ['problemHash', 'pis', 'centrelineToPiLengthMm', 'bends', 'cost', 'optimal', 'expansions', 'engine'] as const;

/** The `solution` parameter equivalent to the data of a committed `auto_route_pipe`. */
function solutionOf(data: Json): Json {
  const { centrelineToPiLengthMm, ...rest } = Object.fromEntries(SOLUTION_KEYS.map((key) => [key, data[key]]));
  return { ...rest, lengthMm: centrelineToPiLengthMm };
}

/**
 * @failure invalid `lines` -> RTE_AUTOROUTE_LINES_INVALID; a native transport error (missing binary, timeout) -> its NATIVE_* code at once; lines
 *   that cannot be routed in any tried order -> RTE_AUTOROUTE_LINES_FAILED (with partial: the lines that routed are kept)
 */
export async function runAutoRouteLines(
  params: Readonly<Json>,
  options: LineOptions,
  host: FeaHost,
  deps: NativeDeps,
  routeLine: SingleRoute,
): Promise<FeaToolResult> {
  const lines = Array.isArray(params['lines']) ? params['lines'].filter(isRecord) : [];
  if (lines.length === 0 || lines.length !== (params['lines'] as unknown[]).length)
    return failure('RTE_AUTOROUTE_LINES_INVALID', 'lines must be a non-empty array of { lineId, from, to, ... }');
  const ids = lines.map((line) => line['lineId']);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length)
    return failure('RTE_AUTOROUTE_LINES_INVALID', 'every line needs its own string lineId');
  const common = isRecord(params['common']) ? params['common'] : {};
  const partial = params['partial'] === true;
  const attempts =
    typeof params['maxAttempts'] === 'number' ? Math.max(1, Math.min(12, Math.floor(params['maxAttempts']))) : DEFAULT_ATTEMPTS;
  const base = host.getDoc();
  const lineById = new Map(lines.map((line) => [line['lineId'] as string, line]));
  const passes: Pass[] = [];
  const promoted: string[] = [];
  const tried = new Set<string>();
  while (passes.length < attempts) {
    const planning = scratchHost(base).applyCommand('route_lines_order', { lines, common, promote: promoted });
    const order = (isRecord(planning.data) ? planning.data['order'] : undefined) as string[] | undefined;
    if (planning.isError || order === undefined) return { ...planning, summary: `${TOOL}: ${planning.summary}` };
    if (tried.has(order.join('\n'))) break;
    tried.add(order.join('\n'));
    const scratch = scratchHost(base);
    const planned: Planned[] = [];
    const failed: Pass['failed'][number][] = [];
    for (const lineId of order) {
      const line = lineById.get(lineId) as Json;
      const routed = await routeLine({ ...common, ...line }, options, scratch, deps);
      if (!routed.isError) {
        planned.push({ line, solution: solutionOf(isRecord(routed.data) ? routed.data : {}) });
        continue;
      }
      const code = codeOf(routed);
      if (code.startsWith('NATIVE_')) return routed;
      failed.push({ lineId, code, summary: routed.summary });
      if (!partial) break;
    }
    passes.push({ order, planned, failed });
    const first = failed[0];
    if (first === undefined || planned.length === 0 || order.indexOf(first.lineId) === 0) break;
    if (!planned.some((entry) => order.indexOf(entry.line['lineId'] as string) < order.indexOf(first.lineId))) break;
    promoted.unshift(first.lineId);
  }
  const best = passes.reduce((top, pass) => (pass.planned.length > top.planned.length ? pass : top), passes[0] as Pass);
  const missing = lines.length - best.planned.length;
  if (missing > 0 && (!partial || best.planned.length === 0))
    return failure(
      'RTE_AUTOROUTE_LINES_FAILED',
      `${missing} of ${lines.length} line(s) not routed after ${passes.length} pass(es): ` +
        best.failed.map((entry) => `${entry.lineId} ${entry.code}`).join('; '),
      best.failed.map((entry) => entry.lineId),
      { passes: passes.map((pass) => ({ order: pass.order, routed: pass.planned.length, failed: pass.failed })) },
    );
  const committed = host.applyCommand('auto_route_lines', {
    lines: best.planned.map((entry) => ({ ...entry.line, solution: entry.solution })),
    common,
    order: 'given',
    partial: false,
  });
  return {
    summary: `${TOOL}: ${lines.length} line(s) planned with llull-compute route in ${passes.length} pass(es). ${committed.summary}`,
    affected: committed.affected,
    isError: committed.isError,
    data: {
      ...(isRecord(committed.data) ? committed.data : {}),
      native: { passes: passes.length, routedInBestPass: best.planned.length, notRouted: best.failed.map((entry) => entry.lineId) },
    },
  };
}
