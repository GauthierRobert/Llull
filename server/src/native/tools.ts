/**
 * The native transports in the `llull` CLI (RS1 §2: CLI-first, local only): hand-written schemas like the FE tools, run in-process
 * against the local document. They never change the document: results are artifacts read back by read-only registry commands.
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

import type { ToolDefinition } from '@protocol/tools';
import type { FeaHost } from '@protocol/index';
import type { CommandOutcome } from '@protocol/restProtocol';
import { getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import { defaultFeArtifactStore } from '../fea/artifactStore';
import { createComputeRunner } from './computeJob';
import { runFatigueField, type NativeDeps } from './fatigueField';
import { runMapField } from './mapField';
import { DEFAULT_TOPOLOGY_TIMEOUT_S, runTopologySolve, type TopologySolveOptions } from './topologySolve';
import { runFeaRender } from './renderField';
import { DEFAULT_AUTO_ROUTE_TIMEOUT_S, NATIVE_EXPANSIONS_CEILING, NATIVE_MAX_EXPANSIONS, runAutoRoute } from './autoRoute';
import { runStackupTool, stackupToolDefinition } from './stackupMonteCarlo';
import { runVortexLatticeTool, vortexLatticeToolDefinition } from './vortexLattice';
import { DEFAULT_EXPLICIT_TIMEOUT_S, runExplicitRun, type ExplicitRunOptions } from './explicitRun';
import { defaultScanDeps, isScanTool, runScanTool, scanToolDefinitions } from '../scan/scanTools';
import { MTEST_TOOL, mtestToolDefinition, runMtestTool } from '../mfront/mtestTool';

const TIMEOUT = {
  type: 'number' as const,
  minimum: 1,
  maximum: 86400,
  description: 'Wall-clock limit of the native job in seconds (default 600).',
};

export function nativeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'fatigue_field',
      description:
        'Run the all-node fatigue job of an FE fatigue case (create_fatigue_case with analysisId) in the native llull-compute binary: superposed ' +
        'load cases, stress measure, rainflow, mean-stress correction and Miner damage on EVERY mesh node (no pre-selection), stored as a ' +
        'content-addressed FatigueField bound to the case inputs. compute_fatigue then ranks the hot spots by damage and recomputes each row ' +
        'in TypeScript (the reference); this tool returns that result too. verify: true also runs the TypeScript reference on every node and ' +
        'reports the agreement. Needs a solved, current analysis (fea_solve). Without llull-compute: NATIVE_TOOL_MISSING.',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: { type: 'string', description: 'Fatigue case id (affected[0] of create_fatigue_case).' },
          timeoutS: TIMEOUT,
          verify: {
            type: 'boolean',
            description: 'Also compute the TypeScript reference on every node and compare (slower). Default false.',
          },
        },
        required: ['caseId'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    {
      name: 'fea_map_field',
      description:
        'Map the thermal result of a thermo_static analysis whose field is thermal_result with mapping "interpolate" onto its mechanical mesh in ' +
        'the native llull-compute binary (same rules as the TypeScript mapping: lowest containing element, nearest-point projection outside). ' +
        'The mapped field is stored bound to the thermal results and the mechanical mesh hash; fea_solve checks both and writes it into the deck ' +
        '(fea_solve also does this by itself on large meshes). Run after fea_mesh. Without llull-compute: NATIVE_TOOL_MISSING (fea_solve maps in TypeScript).',
      inputSchema: {
        type: 'object',
        properties: { analysisId: { type: 'string', description: 'Id of the thermo_static analysis.' }, timeoutS: TIMEOUT },
        required: ['analysisId'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    renderToolDefinition(),
    topologyToolDefinition(),
    mtestToolDefinition(),
    autoRouteToolDefinition(),
    stackupToolDefinition(),
    vortexLatticeToolDefinition(),
    explicitToolDefinition(),
    ...scanToolDefinitions(),
  ];
}

/** auto_route: the params of route_problem plus the transport's own (read from the registry, so both stay one schema). */
function autoRouteToolDefinition(): ToolDefinition {
  const schema = getCommand('route_problem')?.paramsSchema ?? { type: 'object' as const, properties: {}, required: [] };
  return {
    name: 'auto_route',
    description:
      'Auto-route a pipe line between two ports with the native router (llull-compute route, plant 02 RTE V2): route_problem builds the ' +
      'lattice problem from the document, the native sparse 3D A* searches it (up to maxExpansions, default 2e6) and auto_route_pipe validates ' +
      'the solution against the current document (problem hash, legs, clearance, length / bends / cost) and adds the pipe run. Same params as ' +
      'route_problem / auto_route_pipe. data = auto_route_pipe data + native { version, elapsedMs }. Errors: route_problem refusals, ' +
      'RTE_AUTOROUTE_NO_PATH, RTE_AUTOROUTE_BUDGET, RTE_AUTOROUTE_SOLUTION_INVALID, NATIVE_TOOL_MISSING (then auto_route_pipe alone runs the ' +
      'TypeScript search on small grids), NATIVE_TIMEOUT.',
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        timeoutS: { ...TIMEOUT, description: `Wall-clock limit of the native job in seconds (default ${DEFAULT_AUTO_ROUTE_TIMEOUT_S}).` },
        maxExpansions: {
          type: 'integer',
          minimum: 1,
          maximum: NATIVE_EXPANSIONS_CEILING,
          description: `Native expansion budget (default ${NATIVE_MAX_EXPANSIONS}); above it RTE_AUTOROUTE_BUDGET.`,
        },
      },
    },
    annotations: {},
  };
}

/** fea_render: the params of render_fea_results plus `raster` (read from the registry, so both stay one schema). */
function renderToolDefinition(): ToolDefinition {
  const schema = getCommand('render_fea_results')?.paramsSchema ?? { type: 'object' as const, properties: {}, required: [] };
  return {
    name: 'fea_render',
    description:
      'render_fea_results (same params, same data: svg, field, unit, min, max, levels, ...) with the pixel raster drawn by the native llull-compute ' +
      'binary for large headless plots (save with --save plot.png). raster: auto (default: TypeScript below 1e6 supersampled pixels, native CPU ' +
      'above), ts (the TypeScript reference and hash path), cpu (native CPU twin, bit-identical to ts), gpu (wgpu offscreen; a picture, not ' +
      'bit-identical: data.raster.deterministic false). data.raster = { engine ts | native-cpu | native-gpu, deterministic, device?, reason?, ' +
      'elapsedMs }; a missing binary or GPU falls back to the TypeScript raster and says why.',
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        raster: { type: 'string', enum: ['auto', 'ts', 'cpu', 'gpu'], description: 'Raster engine (default auto).' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
}

/** topology_solve: the transport of the topology plugin (PHY-17); the study itself is built with the topology commands. */
function topologyToolDefinition(): ToolDefinition {
  return {
    name: 'topology_solve',
    description:
      'Solve a topology optimization study (create_topology_study, set_topology_regions): builds the voxel grid, maps the 05 loads and supports, ' +
      'runs the native llull-compute SIMP optimiser (progress per iteration with --progress) and records the result with record_topology_result ' +
      '(density field artifact, derived read-only iso-surface on layer layer-topology; numbers are recomputed from the artifact). Concept shape, ' +
      'never a released design: rebuild with suggest_rebuild and finish with check_topology. Without llull-compute a 2D study up to 2000 voxels ' +
      'runs the TypeScript reference; anything larger is TOP_TOOL_MISSING. resumeFromLast continues the last finished run of the study ' +
      '(e.g. after raising maxIterations: the cap counts the iterations already done). Errors: TOP_SOLVER_FAILED, TOP_GRID_TOO_LARGE, TOP_SOLVER_TIMEOUT, TOP_RESULT_STALE.',
    inputSchema: {
      type: 'object',
      properties: {
        studyId: { type: 'string', description: 'Id of the topology study (affected[0] of create_topology_study).' },
        timeoutS: { ...TIMEOUT, description: `Wall-clock limit of the native job in seconds (default ${DEFAULT_TOPOLOGY_TIMEOUT_S}).` },
        resumeFromLast: {
          type: 'boolean',
          description:
            'Continue the last finished run of this study from its saved design (same inputs; settings such as maxIterations may change).',
        },
        device: {
          type: 'string',
          enum: ['cpu', 'gpu', 'auto'],
          description: 'cpu (default, deterministic), gpu or auto (a GPU build of llull-compute; else TOP_GPU_FALLBACK).',
        },
      },
      required: ['studyId'],
    },
    annotations: { idempotentHint: true },
  };
}

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

/** explicit_run: the transport of the explicit plugin (PHY-19 RS-8); the case itself is set up with the explicit commands. */
function explicitToolDefinition(): ToolDefinition {
  return {
    name: 'explicit_run',
    description:
      'Run an explicit_dynamics case (create_analysis analysisType=explicit_dynamics, set_part_idealization, set_explicit_controls, set_initial_velocity, ' +
      'add_rigid_wall) in the native llull-compute explicit solver (central difference, lumped mass, hex8 with Flanagan-Belytschko hourglass ' +
      'control, tet4, elastic or Johnson-Cook plasticity, planar rigid walls; progress with --progress) and record the result with ' +
      'record_explicit_results (fe_explicit artifact; numbers are recomputed from it). Read it with explicit_report and explicit_energy_check. ' +
      'Screening only: review required, never certification evidence. Errors: EXP_TOOL_MISSING (no llull-compute), EXP_SOLVER_FAILED, ' +
      'EXP_RUN_TIMEOUT and the set-up codes (EXP_NO_EXCITATION, EXP_MESH_UNSUPPORTED, EXP_MATERIAL_INCOMPLETE, ...).',
    inputSchema: {
      type: 'object',
      properties: {
        analysisId: { type: 'string', description: 'Id of the explicit_dynamics analysis (affected[0] of create_analysis).' },
        timeoutS: { ...TIMEOUT, description: `Wall-clock limit of the native job in seconds (default ${DEFAULT_EXPLICIT_TIMEOUT_S}).` },
        device: {
          type: 'string',
          enum: ['cpu', 'gpu', 'auto'],
          description:
            'cpu (default, deterministic Rust CPU path), gpu or auto (a GPU build of llull-compute; else the CPU twin with a warning).',
        },
      },
      required: ['analysisId'],
    },
    annotations: { idempotentHint: true },
  };
}

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
    return { ...(await runFatigueField(caseId, { ...timeout, verify: args['verify'] === true }, host, deps)), changed: false };
  }
  const analysisId = nonEmptyString(args['analysisId']);
  if (analysisId === undefined) return failure(`${name}: analysisId is required.`);
  return { ...(await runMapField(analysisId, timeout, host, deps)), changed: false };
}
