/**
 * `vortex_lattice_solve` transport (aerospace 10 AER M3, TECHNICAL_SPEC §2.1, RS1 RS-7): the analyze_vortex_lattice params, lattice built by
 * the same aero model, influence build + dense LU in `llull-compute panel` (crate `llull-panel`, faer) for lattices above the TypeScript cap,
 * loads computed from the returned circulations by the same TypeScript code (same `data` as the command). Query data only.
 */

import type { FeaHost, FeaToolResult } from '@protocol/index';
import type { ToolDefinition } from '@protocol/tools';
import { getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
import { panelCount, solveBasis } from '@aero/aerodynamics/vlmKernel';
import {
  isVlmRefusal,
  resolveVortexLattice,
  VLM_NATIVE_PANEL_CAP,
  VLM_TS_PANEL_CAP,
  vortexLatticeData,
  vortexLatticeParams,
  type VortexLatticeModel,
} from '@aero/aerodynamics/vlmModel';
import { feaFailure } from '../fea/feaCommon';
import { f64Bytes, f64Values, readOutput, withJobFolder, type ComputeRunner } from './computeJob';

const TOOL = 'vortex_lattice_solve';
const DEFAULT_TIMEOUT_S = 600;

export interface PanelNativeDeps {
  readonly runner: ComputeRunner;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PanelNativeOptions {
  readonly timeoutS?: number;
  /** Also solve in TypeScript (lattices up to VLM_TS_PANEL_CAP) and report the largest Γ difference relative to max |Γ|. */
  readonly verify?: boolean;
}

/** vortex_lattice_solve: the analyze_vortex_lattice params (read from the registry, one schema) plus timeoutS and verify. */
export function vortexLatticeToolDefinition(): ToolDefinition {
  const schema = getCommand('analyze_vortex_lattice')?.paramsSchema ?? { type: 'object' as const, properties: {}, required: [] };
  return {
    name: TOOL,
    description:
      'analyze_vortex_lattice (same params, same data) with the influence matrix and the dense LU solved by the native llull-compute binary ' +
      `(crate llull-panel, faer, all cores): for lattices above the ${VLM_TS_PANEL_CAP}-panel TypeScript cap, up to ${VLM_NATIVE_PANEL_CAP} ` +
      'panels (both sides). The influence matrix is bit-identical to the TypeScript one; circulations agree to round-off. data.solver = ' +
      '{ engine "native", tool, version, threads, buildMs, factorMs, residualX, residualZ }. verify: true also solves in TypeScript (up to ' +
      `${VLM_TS_PANEL_CAP} panels) and reports the largest circulation difference. Without llull-compute: NATIVE_TOOL_MISSING.`,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        timeoutS: {
          type: 'number',
          minimum: 1,
          maximum: 86400,
          description: 'Wall-clock limit of the native job in seconds (default 600).',
        },
        verify: { type: 'boolean', description: `Also solve in TypeScript (<= ${VLM_TS_PANEL_CAP} panels) and compare. Default false.` },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
}

function verification(model: VortexLatticeModel, gamma: Float64Array): Record<string, unknown> {
  const n = panelCount(model.lattice.panels);
  if (n > VLM_TS_PANEL_CAP) return { skipped: `${n} panels exceed the TypeScript cap ${VLM_TS_PANEL_CAP}` };
  const started = Date.now();
  const reference = solveBasis(model.lattice.panels);
  if (reference === null) return { skipped: 'the TypeScript solve found the matrix singular' };
  const ts = [...reference.gammaX, ...reference.gammaZ];
  const scale = Math.max(...ts.map(Math.abs));
  return {
    referenceMs: Date.now() - started,
    largestGammaDifference: Math.max(...ts.map((value, i) => Math.abs(value - (gamma[i] as number)))) / scale,
  };
}

/**
 * @failure invalid params -> CMD_INVALID_PARAMS; model refusals -> the AER_* codes of analyze_vortex_lattice (cap 20000 panels); binary absent ->
 *   NATIVE_TOOL_MISSING; singular -> NATIVE_PANEL_SINGULAR; job error / timeout / protocol -> its code
 */
export async function runVortexLatticeSolve(
  params: unknown,
  options: PanelNativeOptions,
  host: FeaHost,
  deps: PanelNativeDeps,
): Promise<FeaToolResult> {
  const parsed = vortexLatticeParams.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return feaFailure(TOOL, 'CMD_INVALID_PARAMS', `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid params'}`);
  }
  const model = resolveVortexLattice(host.getDoc(), parsed.data, VLM_NATIVE_PANEL_CAP);
  if (isVlmRefusal(model)) return { ...feaFailure(TOOL, model.code, model.message), data: { code: model.code, paths: model.paths } };
  const n = panelCount(model.lattice.panels);
  const seconds = Math.max(1, Math.min(86_400, options.timeoutS ?? DEFAULT_TIMEOUT_S));
  const outcome = await withJobFolder(
    { 'job.json': JSON.stringify({ panels: n }), 'panels.f64': f64Bytes(model.lattice.panels) },
    async (folder) => {
      const run = await deps.runner.run(['panel'], folder, seconds * 1000);
      if (!run.ok) return { run, gamma: null, report: null };
      const gamma = f64Values(await readOutput(folder, run, 'gamma.f64'));
      const report: unknown = JSON.parse((await readOutput(folder, run, 'solve.json')).toString('utf8'));
      return { run, gamma, report };
    },
    deps.env,
  ).catch((error: unknown) => ({ run: null, gamma: null, report: null, error: error instanceof Error ? error.message : String(error) }));
  if (outcome.run === null) return feaFailure(TOOL, 'NATIVE_PROTOCOL', 'error' in outcome ? outcome.error : 'job folder failure');
  const { run, gamma, report } = outcome;
  if (gamma === null) {
    const hint =
      run.code === 'NATIVE_TOOL_MISSING' ? ` analyze_vortex_lattice still solves up to ${VLM_TS_PANEL_CAP} panels in TypeScript.` : '';
    return {
      ...feaFailure(TOOL, run.code ?? 'NATIVE_JOB_FAILED', `${run.message ?? 'llull-compute failed'}.${hint}`),
      data: { code: run.code, log: run.log.slice(-4000) },
    };
  }
  if (gamma.length !== 2 * n || !isRecord(report))
    return feaFailure(TOOL, 'NATIVE_PROTOCOL', `gamma.f64 holds ${gamma.length} values, ${2 * n} expected`);
  const solver = {
    engine: 'native' as const,
    tool: 'llull-compute panel',
    version: await deps.runner.version(),
    threads: report['threads'],
    buildMs: report['buildMs'],
    factorMs: report['factorMs'],
    residualX: report['residualX'],
    residualZ: report['residualZ'],
    elapsedMs: run.elapsedMs,
  };
  const data = vortexLatticeData(model, { gammaX: gamma.subarray(0, n), gammaZ: gamma.subarray(n) }, solver);
  const checked = options.verify === true ? verification(model, gamma) : undefined;
  const np = data['neutralPoint'] as { x: number; staticMargin: number };
  return {
    summary:
      `vortex_lattice_solve ${model.names.join(' + ')}: llull-compute solved ${n} panels on ${String(solver.threads)} threads in ${run.elapsedMs} ms; ` +
      `CL_α ${String(data['liftSlopePerRad'])}/rad, neutral point x ${np.x}, static margin ${np.staticMargin}` +
      (checked === undefined ? '' : `; TypeScript check: ${JSON.stringify(checked)}`) +
      '.',
    affected: [],
    isError: false,
    data: { ...data, ...(checked === undefined ? {} : { verification: checked }) },
  };
}

/** Runs the transport with `timeoutS` / `verify` taken from the params. */
export function runVortexLatticeTool(params: unknown, host: FeaHost, deps: PanelNativeDeps): Promise<FeaToolResult> {
  const args = isRecord(params) ? params : {};
  const { timeoutS, verify, ...rest } = args;
  const options: PanelNativeOptions = {
    ...(typeof timeoutS === 'number' && Number.isFinite(timeoutS) ? { timeoutS } : {}),
    verify: verify === true,
  };
  return runVortexLatticeSolve(rest, options, host, deps);
}
