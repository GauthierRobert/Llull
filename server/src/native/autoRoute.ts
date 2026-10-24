/**
 * `auto_route` transport (plant 02 RTE §2.A, RS1 RS-7): `route_problem` builds the canonical problem from the document, `llull-compute
 * route` searches it (sparse 3D A*, NDJSON progress) and `auto_route_pipe { ..., solution }` validates the solution against the problem
 * rebuilt from the current document before committing it. The native code never writes the document; a missing binary refuses with
 * NATIVE_TOOL_MISSING (the in-process TypeScript search still runs through `auto_route_pipe` without `solution`, under its cap).
 * With `lines` it routes several lines in one transaction (`./autoRouteLines`).
 */

import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@protocol/index';
import { isRecord } from '@lib/isRecord';
import { feaFailure } from '../fea/feaCommon';
import { readOutput, withJobFolder, type JobRun } from './computeJob';
import { nativeInstallHint } from './nativeBinary';
import type { NativeDeps } from './fatigueField';
import { runAutoRouteLines } from './autoRouteLines';

const TOOL = 'auto_route';
export const DEFAULT_AUTO_ROUTE_TIMEOUT_S = 60;
/** 02 RTE §8 native budget (expansions); `maxExpansions` may raise it. */
export const NATIVE_MAX_EXPANSIONS = 2_000_000;
/** Ceiling of `maxExpansions`, per first-move candidate (memory guard: ~7.4e6 expansions took 37 s and a few hundred MB on the development laptop). */
export const NATIVE_EXPANSIONS_CEILING = 20_000_000;
/** Ceiling of the expansions of all (up to 5) candidates of one search together: each candidate gets at most this / candidates, so memory stays bounded. */
const NATIVE_TOTAL_EXPANSIONS_CEILING = 20_000_000;

/** Params of the transport itself; everything else is forwarded to route_problem / auto_route_pipe. */
const TRANSPORT_KEYS: ReadonlySet<string> = new Set(['timeoutS', 'maxExpansions', 'solution', 'transactionTimeoutS']);

export interface AutoRouteOptions {
  readonly timeoutS?: number;
  readonly maxExpansions?: number;
}

type Vec3 = [number, number, number];

interface NativeResult {
  readonly status: 'found' | 'no_path' | 'budget';
  readonly problemHash: string;
  readonly expansions: number;
  readonly version: string;
  readonly pisUm?: readonly Vec3[];
  readonly lengthUm?: number;
  readonly bends?: number;
  readonly cost?: number;
  readonly optimal?: boolean;
}

const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(Number.isInteger);

/** `result.json` read back, or an explanation. */
export function parseRouteResult(text: string): NativeResult | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'result.json is not JSON';
  }
  if (!isRecord(value)) return 'result.json is not an object';
  const { status, problemHash, expansions, version, pisUm, lengthUm, bends, cost, optimal } = value;
  if (
    (status !== 'found' && status !== 'no_path' && status !== 'budget') ||
    typeof problemHash !== 'string' ||
    typeof expansions !== 'number'
  )
    return 'result.json lacks status, problemHash or expansions';
  const base = { status, problemHash, expansions, version: typeof version === 'string' ? version : 'unknown' } as const;
  if (status !== 'found') return base;
  if (
    !Array.isArray(pisUm) ||
    !pisUm.every(isVec3) ||
    typeof lengthUm !== 'number' ||
    typeof bends !== 'number' ||
    typeof cost !== 'number'
  )
    return 'a found result lacks pisUm, lengthUm, bends or cost';
  return { ...base, pisUm, lengthUm, bends, cost, optimal: optimal === true };
}

const routeParams = (params: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([key]) => !TRANSPORT_KEYS.has(key)));

const failure = (code: string, message: string, ids: readonly string[] = [], extra: Record<string, unknown> = {}): FeaToolResult => ({
  ...feaFailure(TOOL, code, message, ids),
  data: { code, ...extra },
});

const nativeFailure = (run: JobRun): FeaToolResult =>
  run.code === 'NATIVE_TOOL_MISSING'
    ? failure(
        'NATIVE_TOOL_MISSING',
        `${nativeInstallHint('llull-compute')}; or call auto_route_pipe without solution (TypeScript search, small grids)`,
      )
    : failure(
        run.code ?? 'NATIVE_JOB_FAILED',
        `${run.message ?? 'llull-compute route failed'}. Last output:\n${run.log.slice(-2000)}`,
        [],
        { nativeCode: run.code },
      );

/**
 * @failure route_problem refusals (their RTE_* code); missing binary -> NATIVE_TOOL_MISSING; timeout / job errors -> the native code;
 *   no route -> RTE_AUTOROUTE_NO_PATH / RTE_AUTOROUTE_BUDGET; auto_route_pipe refusals (RTE_AUTOROUTE_SOLUTION_INVALID, a document changed
 *   meanwhile) -> its code. Only auto_route_pipe changes the document.
 */
export async function runAutoRoute(
  params: Readonly<Record<string, unknown>>,
  options: AutoRouteOptions,
  host: FeaHost,
  deps: NativeDeps,
): Promise<FeaToolResult> {
  if (params['lines'] !== undefined) return runAutoRouteLines(params, options, host, deps, runAutoRoute);
  const forwarded = routeParams(params);
  const built = host.applyCommand('route_problem', forwarded);
  if (built.isError) return { ...built, summary: `${TOOL}: ${built.summary}` };
  const { problem, problemHash } = (built.data ?? {}) as { problem?: unknown; problemHash?: unknown };
  if (problem === undefined || typeof problemHash !== 'string') return failure('NATIVE_PROTOCOL', 'route_problem returned no problem');
  if (deps.runner.binary === null)
    return nativeFailure({ ok: false, outputs: [], code: 'NATIVE_TOOL_MISSING', warnings: [], log: '', elapsedMs: 0 });
  const seconds = Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, options.timeoutS ?? DEFAULT_AUTO_ROUTE_TIMEOUT_S));
  const maxExpansions = Math.min(options.maxExpansions ?? NATIVE_MAX_EXPANSIONS, NATIVE_EXPANSIONS_CEILING);
  const sink = deps.onProgress;
  const outcome = await withJobFolder(
    { 'job.json': JSON.stringify({ problemHash, problem, maxExpansions, maxTotalExpansions: NATIVE_TOTAL_EXPANSIONS_CEILING }) },
    async (folder) => {
      const run = await deps.runner.run(
        ['route'],
        folder,
        seconds * 1000,
        sink === undefined ? undefined : (event) => sink(`${TOOL}: ${String(event['step'])} / ${String(event['total'])} expansions`),
      );
      return run.ok ? { run, text: (await readOutput(folder, run, 'result.json')).toString('utf8') } : { run, text: null };
    },
    deps.env,
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in outcome) return failure('NATIVE_PROTOCOL', `the job folder or its output failed: ${outcome.error}`);
  if (outcome.text === null) return nativeFailure(outcome.run);
  const result = parseRouteResult(outcome.text);
  if (typeof result === 'string') return failure('NATIVE_PROTOCOL', result);
  if (result.problemHash !== problemHash)
    return failure('NATIVE_PROTOCOL', `the job answered problem ${result.problemHash}, not ${problemHash}`);
  const lineId = typeof params['lineId'] === 'string' ? [params['lineId']] : [];
  if (result.status === 'no_path')
    return failure(
      'RTE_AUTOROUTE_NO_PATH',
      `no clear route in the grid box (${result.expansions} expansions); widen gridMargin or lower clearance`,
      lineId,
    );
  if (result.status === 'budget')
    return failure(
      'RTE_AUTOROUTE_BUDGET',
      `no route within ${result.expansions} expansions; raise maxExpansions or use a coarser grid`,
      lineId,
    );
  const solution = {
    problemHash,
    pis: (result.pisUm ?? []).map((p) => p.map((v) => v / 1000)),
    lengthMm: (result.lengthUm ?? 0) / 1000,
    bends: result.bends ?? 0,
    cost: result.cost ?? 0,
    optimal: result.optimal === true,
    expansions: result.expansions,
    engine: 'llull-route',
  };
  const recorded = host.applyCommand('auto_route_pipe', { ...forwarded, solution });
  return {
    summary: `${TOOL}: llull-compute route ${result.version}, ${result.expansions} expansions in ${outcome.run.elapsedMs} ms. ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      ...(isRecord(recorded.data) ? recorded.data : {}),
      native: { version: result.version, elapsedMs: outcome.run.elapsedMs, maxExpansions },
    },
  };
}
