/**
 * The native transports in the `llull` CLI (RS1 §2: CLI-first, local only): run in-process
 * against the local document (their schema-only definitions are `@protocol/nativeTools`). They never change the document: results are artifacts read back by read-only registry commands.
 *   fatigue_field  FE fatigue case -> llull-compute post fatigue (every node) -> FatigueField artifact -> compute_fatigue
 *   fea_map_field  thermo_static interpolate field -> llull-compute post map -> mapped-field artifact (read by the fea_solve deck)
 *   fea_render     render_fea_results with the pixel raster in llull-compute raster (raster=auto|ts|cpu|gpu)
 *   mtest_run      optional user-installed MFront / MTest (not llull-compute): runs an MTest script, returns its result table
 *   auto_route     route_problem -> llull-compute route (plant 02 RTE V2 A*) -> auto_route_pipe { solution } (validated, then committed)
 *   stackup_monte_carlo  analyze_stackup with the Monte Carlo above the TS cap in llull-compute stats (GDT TR-GDT-22)
 *   vortex_lattice_solve analyze_vortex_lattice with the influence build + dense LU in llull-compute panel (AER M3)
 *   explicit_run   explicit_dynamics case -> llull-compute explicit -> fe_explicit artifact -> record_explicit_results (PHY-19 RS-8)
 *   scan_import / scan_list  point-cloud file -> llull-compute cloud import -> asset store (`../scan/scanTools.ts`, plant 10)
 */

import type { FeaHost } from '@protocol/index';
import type { CommandOutcome } from '@protocol/restProtocol';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import { defaultFeArtifactStore } from '../fea/artifactStore';
import { createComputeRunner } from './computeJob';
import { runFatigueField, type NativeDeps } from './fatigueField';
import { runMapField } from './mapField';
import { runTopologySolve, type TopologySolveOptions } from './topologySolve';
import { runFeaRender } from './renderField';
import { runAutoRoute } from './autoRoute';
import { runStackupTool } from './stackupMonteCarlo';
import { runVortexLatticeTool } from './vortexLattice';
import { runExplicitRun, type ExplicitRunOptions } from './explicitRun';
import { defaultScanDeps, isScanTool, runScanTool } from '../scan/scanTools';
import { MTEST_TOOL, runMtestTool } from '../mfront/mtestTool';

const NAMES: ReadonlySet<string> = new Set([
  'fatigue_field',
  'fea_map_field',
  'fea_render',
  'topology_solve',
  'stackup_monte_carlo',
  'vortex_lattice_solve',
  'auto_route',
  'explicit_run',
  MTEST_TOOL,
]);

export const isNativeTool = (name: string): boolean => NAMES.has(name);

function defaultDeps(env: NodeJS.ProcessEnv, onProgress?: (line: string) => void): NativeDeps {
  return { store: defaultFeArtifactStore(), runner: createComputeRunner(env), env, ...(onProgress !== undefined ? { onProgress } : {}) };
}

const failure = (summary: string): CommandOutcome => ({ summary, affected: [], isError: true, changed: false });

/**
 * Runs a native transport against `host`; null for any other tool name.
 * @failure missing id parameter -> isError outcome; transport failures are outcomes (never throws)
 */
export async function runNativeTool(
  name: string,
  params: unknown,
  host: FeaHost & { readonly onProgress?: (line: string) => void },
  deps: NativeDeps = defaultDeps(process.env, host.onProgress),
): Promise<CommandOutcome | null> {
  if (isScanTool(name)) return runScanTool(name, params, defaultScanDeps(deps.env, host.onProgress));
  if (!isNativeTool(name)) return null;
  if (name === MTEST_TOOL) return runMtestTool(params);
  if (name === 'fea_render') return { ...(await runFeaRender(params, host, deps)), changed: false };
  if (name === 'stackup_monte_carlo') return { ...(await runStackupTool(params, host, deps)), changed: false };
  if (name === 'vortex_lattice_solve') return { ...(await runVortexLatticeTool(params, host, deps)), changed: false };
  const args = isRecord(params) ? params : {};
  if (name === 'topology_solve') {
    const studyId = nonEmptyString(args['studyId']);
    if (studyId === undefined) return failure('topology_solve: studyId is required.');
    const device = args['device'];
    const options: TopologySolveOptions = {
      ...(typeof args['timeoutS'] === 'number' && Number.isFinite(args['timeoutS']) ? { timeoutS: args['timeoutS'] } : {}),
      ...(args['resumeFromLast'] === true ? { resumeFromLast: true } : {}),
      ...(device === 'cpu' || device === 'gpu' || device === 'auto' ? { device } : {}),
    };
    const before = host.getDoc();
    const result = await runTopologySolve(studyId, options, host, deps);
    return { ...result, changed: host.getDoc() !== before };
  }
  const timeout = typeof args['timeoutS'] === 'number' && Number.isFinite(args['timeoutS']) ? { timeoutS: args['timeoutS'] } : {};
  if (name === 'auto_route') {
    const maxExpansions = args['maxExpansions'];
    const options = {
      ...timeout,
      ...(typeof maxExpansions === 'number' && Number.isInteger(maxExpansions) && maxExpansions > 0 ? { maxExpansions } : {}),
    };
    const before = host.getDoc();
    const result = await runAutoRoute(args, options, host, deps);
    return { ...result, changed: host.getDoc() !== before };
  }
  if (name === 'explicit_run') {
    const analysisId = nonEmptyString(args['analysisId']);
    if (analysisId === undefined) return failure('explicit_run: analysisId is required.');
    const device = args['device'];
    const options: ExplicitRunOptions = { ...timeout, ...(device === 'cpu' || device === 'gpu' || device === 'auto' ? { device } : {}) };
    const before = host.getDoc();
    const result = await runExplicitRun(analysisId, options, host, deps);
    return { ...result, changed: host.getDoc() !== before };
  }
  if (name === 'fatigue_field') {
    const caseId = nonEmptyString(args['caseId']);
    if (caseId === undefined) return failure('fatigue_field: caseId is required.');
    return { ...(await runFatigueField(caseId, timeout, host, deps)), changed: false };
  }
  const analysisId = nonEmptyString(args['analysisId']);
  if (analysisId === undefined) return failure(`${name}: analysisId is required.`);
  return { ...(await runMapField(analysisId, timeout, host, deps)), changed: false };
}
