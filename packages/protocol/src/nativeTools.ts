/**
 * Native-transport tool definitions (schema only): fatigue_field, fea_map_field, fea_render, topology_solve, explicit_run, mtest_run,
 * auto_route, stackup_monte_carlo, vortex_lattice_solve, scan_import, scan_list, cfd_solve. Like the exchange / FE tools they are not registry
 * commands; the runners (llull-compute jobs, MFront, the cloud store) live in `server/src/native`, `server/src/cfd`, `server/src/mfront` and `server/src/scan`.
 *
 * Schemas come from zod through the registry's own `toParamsSchema`; tools that wrap a command (fea_render, auto_route, stackup_monte_carlo,
 * vortex_lattice_solve) read that command's `paramsSchema` so both stay one schema. Each spec carries its toolset (no hand-kept name list).
 * The numeric defaults in the descriptions mirror the server runners; `server/tests/nativeToolDefinitions.test.ts` pins them.
 */
import { getCommand } from '@core/commands/registry';
import { toParamsSchema, z } from '@core/commands/schema';
import type { ParamsSchema } from '@core/commands/types';
import { DOCUMENT_UNITS } from '@core/model/types';
import type { ToolDefinition } from './tools';

/** Toolsets that own native transports (a subset of `ToolsetName`, declared here so `toolsets.ts` can import this file without a cycle). */
type NativeToolset = 'analysis' | 'pmi' | 'aerodynamics' | 'piping' | 'scan' | 'flow' | 'mesh';

interface NativeToolSpec {
  readonly name: string;
  readonly toolset: NativeToolset;
  readonly build: () => ToolDefinition;
}

const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 86400;
/** Bounds of the inflow lattice Mach number of `cfd_solve` (the job refuses outside (0, 0.3]). */
const LATTICE_MACH_MIN = 1e-6;
const LATTICE_MACH_MAX = 0.3;
const EMPTY_SCHEMA: ParamsSchema = { type: 'object', properties: {}, required: [] };

/** Wall-clock limit parameter: zod has no bounds in `ParamSpec`, so `minimum` / `maximum` are added after derivation. */
const timeoutS = (description: string): z.ZodOptional<z.ZodNumber> => z.number().optional().describe(description);

/** zod object -> `ParamsSchema`, with the 1..86400 s bounds on `timeoutS` when present. */
function schemaOf(shape: z.ZodObject): ParamsSchema {
  const schema = toParamsSchema(shape);
  const timeout = schema.properties['timeoutS'];
  if (timeout !== undefined) timeout.minimum = TIMEOUT_MIN_S;
  if (timeout !== undefined) timeout.maximum = TIMEOUT_MAX_S;
  const steps = schema.properties['maxSteps'];
  if (steps !== undefined) steps.minimum = 1;
  const mach = schema.properties['latticeMach'];
  if (mach !== undefined) mach.minimum = LATTICE_MACH_MIN;
  if (mach !== undefined) mach.maximum = LATTICE_MACH_MAX;
  return schema;
}

/** The paramsSchema of the registry command a transport wraps, extended with the transport's own properties. */
function wrappedSchema(command: string, extra: z.ZodObject): ParamsSchema {
  const base = getCommand(command)?.paramsSchema ?? EMPTY_SCHEMA;
  const own = schemaOf(extra);
  return { ...base, properties: { ...base.properties, ...own.properties } };
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;
const deviceParam = (description: string): z.ZodOptional<z.ZodEnum<{ cpu: 'cpu'; gpu: 'gpu'; auto: 'auto' }>> =>
  z.enum(['cpu', 'gpu', 'auto']).optional().describe(description);

const fatigueField = (): ToolDefinition => ({
  name: 'fatigue_field',
  description:
    'Run the all-node fatigue job of an FE fatigue case (create_fatigue_case with analysisId) in the native llull-compute binary: superposed ' +
    'load cases, stress measure, rainflow, mean-stress correction and Miner damage on EVERY mesh node (no pre-selection), stored as a ' +
    'content-addressed FatigueField bound to the case inputs. compute_fatigue then ranks the hot spots by damage and recomputes each row ' +
    'in TypeScript (the reference); this tool returns that result too. Needs a solved, current analysis (fea_solve). Without llull-compute: NATIVE_TOOL_MISSING.',
  inputSchema: schemaOf(
    z.object({
      caseId: z.string().describe('Fatigue case id (affected[0] of create_fatigue_case).'),
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 600).'),
    }),
  ),
  annotations: READ_ONLY,
});

const feaMapField = (): ToolDefinition => ({
  name: 'fea_map_field',
  description:
    'Map the thermal result of a thermo_static analysis whose field is thermal_result with mapping "interpolate" onto its mechanical mesh in ' +
    'the native llull-compute binary (same rules as the TypeScript mapping: lowest containing element, nearest-point projection outside). ' +
    'The mapped field is stored bound to the thermal results and the mechanical mesh hash; fea_solve checks both and writes it into the deck ' +
    '(fea_solve also does this by itself on large meshes). Run after fea_mesh. Without llull-compute: NATIVE_TOOL_MISSING (fea_solve maps in TypeScript).',
  inputSchema: schemaOf(
    z.object({
      analysisId: z.string().describe('Id of the thermo_static analysis.'),
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 600).'),
    }),
  ),
  annotations: READ_ONLY,
});

const feaRender = (): ToolDefinition => ({
  name: 'fea_render',
  description:
    'Large headless FE results plot with the pixel raster drawn by the native llull-compute ' +
    'binary (save with --save plot.png); same params and same data as render_fea_results (svg, field, unit, min, max, levels, ...). raster: auto (default: TypeScript below 1e6 supersampled pixels, native CPU ' +
    'above), ts (the TypeScript reference and hash path), cpu (native CPU twin, bit-identical to ts), gpu (wgpu offscreen; an image, not ' +
    'bit-identical: data.raster.deterministic false). data.raster = { engine ts | native-cpu | native-gpu, deterministic, device?, reason?, ' +
    'elapsedMs }; a missing binary or GPU falls back to the TypeScript raster and says why.',
  inputSchema: wrappedSchema(
    'render_fea_results',
    z.object({ raster: z.enum(['auto', 'ts', 'cpu', 'gpu']).optional().describe('Raster engine (default auto).') }),
  ),
  annotations: READ_ONLY,
});

const topologySolve = (): ToolDefinition => ({
  name: 'topology_solve',
  description:
    'Solve a topology optimization study (create_topology_study, set_topology_regions): builds the voxel grid, maps the 05 loads (force, pressure, ' +
    'gravity) and supports, runs the native llull-compute SIMP optimiser (OC or MMA, projection, extrusion; progress per iteration with --progress) ' +
    'and records the result with record_topology_result (density field artifact, derived read-only iso-surface on layer layer-topology; numbers ' +
    'are recomputed from the artifact). Concept shape, never a released design: rebuild with suggest_rebuild and finish with check_topology. ' +
    'Without llull-compute the tool is TOP_TOOL_MISSING (no TypeScript fallback). The job checkpoints itself about 90 % into timeoutS: a TOP_SOLVER_TIMEOUT ' +
    'with resumable=true keeps the run, and resumeFromLast continues it (or a finished run, e.g. after raising maxIterations: the cap counts the ' +
    'iterations already done) bit for bit. Errors: TOP_SOLVER_FAILED, TOP_GRID_TOO_LARGE, TOP_SOLVER_TIMEOUT, TOP_RESULT_STALE, TOP_OPTIMIZER_MISMATCH.',
  inputSchema: schemaOf(
    z.object({
      studyId: z.string().describe('Id of the topology study (affected[0] of create_topology_study).'),
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 1800); the job checkpoints about 90 % into it.'),
      resumeFromLast: z
        .boolean()
        .optional()
        .describe(
          'Continue the last run of this study (finished or checkpointed) from its saved design, warm start and optimizer state (same inputs; ' +
            'settings such as maxIterations may change).',
        ),
      device: deviceParam('cpu (default, deterministic), gpu or auto (a GPU build of llull-compute; else TOP_GPU_FALLBACK).'),
    }),
  ),
  annotations: { idempotentHint: true },
});

const explicitRun = (): ToolDefinition => ({
  name: 'explicit_run',
  description:
    'Run an explicit_dynamics case (create_analysis analysisType=explicit_dynamics, set_part_idealization, set_explicit_controls, set_initial_velocity, ' +
    'add_rigid_wall) in the native llull-compute explicit solver (central difference, lumped mass, hex8 with Flanagan-Belytschko hourglass ' +
    'control, tet4, elastic or Johnson-Cook plasticity, planar rigid walls; progress with --progress) and record the result with ' +
    'record_explicit_results (fe_explicit artifact; numbers are recomputed from it). Read it with analysis_report view explicit and explicit_energy_check. ' +
    'Screening only: review required, never certification evidence. Errors: EXP_TOOL_MISSING (no llull-compute), EXP_SOLVER_FAILED, ' +
    'EXP_RUN_TIMEOUT and the set-up codes (EXP_NO_EXCITATION, EXP_MESH_UNSUPPORTED, EXP_MATERIAL_INCOMPLETE, ...).',
  inputSchema: schemaOf(
    z.object({
      analysisId: z.string().describe('Id of the explicit_dynamics analysis (affected[0] of create_analysis).'),
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 3600).'),
      device: deviceParam(
        'cpu (default, deterministic Rust CPU path), gpu or auto (a GPU build of llull-compute; else the CPU twin with a warning).',
      ),
    }),
  ),
  annotations: { idempotentHint: true },
});

const mtestRun = (): ToolDefinition => ({
  name: 'mtest_run',
  description:
    'OPTIONAL MFront / MTest transport (not bundled: install TFEL / MFront yourself and set LLULL_MTEST, and LLULL_MFRONT to compile; ' +
    'see docs/physics/02-constitutive-models TECHNICAL_SPEC §11 OQ-MATL-05). Runs an MTest script on a behaviour outside the built-in law ' +
    'set and returns the result table (time, strains, stresses, state variables) as data; the document is never changed. ' +
    'mtest = the text of the .mtest script. mfront = { name, source } compiles that MFront behaviour first with ' +
    '`mfront --obuild --interface=generic name.mfront` in the job folder; the token {{library}} in the script is replaced by ' +
    "src/lib<library>.<so|dll|dylib> (library defaults to 'Behaviour'; give the same name as @Library in the source). " +
    'Running needs LLULL_ALLOW_CODE_EXECUTION=1 (native code is compiled and loaded). probe: true only reports which tools were found. ' +
    'Errors: MFRONT_TOOL_MISSING (with the reason), MFRONT_CODE_EXECUTION_DISABLED, MFRONT_BUILD_FAILED, MTEST_FAILED, MTEST_TIMEOUT, ' +
    'MTEST_RESULT_MISSING. Compare with material_point_response for the same path; MTest results are not llull-validated values.',
  inputSchema: schemaOf(
    z.object({
      mtest: z.string().optional().describe('Text of the MTest script (.mtest). May contain the token {{library}}.'),
      mfront: z
        .object({
          name: z.string().describe('Behaviour file name without extension: letters, digits, underscore.'),
          source: z.string().describe('Text of the .mfront source.'),
          library: z.string().optional().describe("Library name (default 'Behaviour'); the one the source declares with @Library."),
        })
        .optional()
        .describe('MFront behaviour to compile before the run (needs mfront).'),
      timeoutS: timeoutS('Wall-clock limit per process in seconds (default 120).'),
      probe: z.boolean().optional().describe('Report the detected tools and run nothing.'),
    }),
  ),
});

function autoRouteSchema(): ParamsSchema {
  const schema = wrappedSchema(
    'route_problem',
    z.object({
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 60).'),
      maxExpansions: z.number().int().optional().describe('Native expansion budget (default 2000000); above it RTE_AUTOROUTE_BUDGET.'),
    }),
  );
  const budget = schema.properties['maxExpansions'];
  if (budget !== undefined) Object.assign(budget, { minimum: 1, maximum: 20_000_000 });
  return schema;
}

const autoRoute = (): ToolDefinition => ({
  name: 'auto_route',
  description:
    'Auto-route a pipe line between two ports with the native router (llull-compute route, plant 02 RTE V2): route_problem builds the ' +
    'lattice problem from the document, the native sparse 3D A* searches it (up to maxExpansions, default 2e6) and auto_route_pipe validates ' +
    'the solution against the current document (problem hash, legs, clearance, length / bends / cost) and adds the pipe run. Same params as ' +
    'route_problem / auto_route_pipe. data = auto_route_pipe data + native { version, elapsedMs }. Errors: route_problem refusals, ' +
    'RTE_AUTOROUTE_NO_PATH, RTE_AUTOROUTE_BUDGET, RTE_AUTOROUTE_SOLUTION_INVALID, NATIVE_TOOL_MISSING (then auto_route_pipe alone runs the ' +
    'TypeScript search on small grids), NATIVE_TIMEOUT.',
  inputSchema: autoRouteSchema(),
  annotations: {},
});

const stackupMonteCarlo = (): ToolDefinition => ({
  name: 'stackup_monte_carlo',
  description:
    'analyze_stackup (same params, same data) with the Monte Carlo run by the native llull-compute binary (crate llull-stats, rayon): ' +
    'for samples above the 2000000 TypeScript cap, up to 2^40 (default 10000000). It draws the same ' +
    'Philox4x32-10 samples as analyze_stackup and reduces them in the same fixed order, so the numbers do not depend on the thread count ' +
    'and equal the TypeScript ones bit for bit for expressions without trigonometric functions (data.monteCarlo.bitExactWithTs). ' +
    'monteCarlo is always run; data.monteCarlo.engine "native", provenance { tool, version, threads, deterministic }. verify: true also ' +
    'runs the TypeScript sampler (samples <= 2000000) and reports the agreement. Without llull-compute: NATIVE_TOOL_MISSING.',
  inputSchema: wrappedSchema(
    'analyze_stackup',
    z.object({
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 600).'),
      verify: z.boolean().optional().describe('Also run the TypeScript sampler (samples <= 2000000) and compare. Default false.'),
    }),
  ),
  annotations: READ_ONLY,
});

const vortexLatticeSolve = (): ToolDefinition => ({
  name: 'vortex_lattice_solve',
  description:
    'analyze_vortex_lattice (same params, same data) with the influence matrix and the dense LU solved by the native llull-compute binary ' +
    '(crate llull-panel, faer, all cores): for lattices above the 1000-panel TypeScript cap, up to 20000 ' +
    'panels (both sides). The influence matrix is bit-identical to the TypeScript one; circulations agree to round-off. data.solver = ' +
    '{ engine "native", tool, version, threads, buildMs, factorMs, residualX, residualZ }. verify: true also solves in TypeScript (up to ' +
    '1000 panels) and reports the largest circulation difference. Without llull-compute: NATIVE_TOOL_MISSING.',
  inputSchema: wrappedSchema(
    'analyze_vortex_lattice',
    z.object({
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 600).'),
      verify: z.boolean().optional().describe('Also solve in TypeScript (<= 1000 panels) and compare. Default false.'),
    }),
  ),
  annotations: READ_ONLY,
});

const scanImport = (): ToolDefinition => ({
  name: 'scan_import',
  description:
    "Import a point-cloud file (E57, LAS, LAZ, or ASCII XYZ / PTS / CSV) into this machine's cloud store with the native llull-compute " +
    '(readers, octree, lossless integer coordinates). Prints the sourceSha256, the content-addressed assetKey and the manifest summary ' +
    '(points, scans, bounds, attributes, warnings). The document is NOT changed: attach the cloud with attach_point_cloud assetKey=<key>. ' +
    'Re-importing the same file with the same options is instant (cached). ReCap RCP / RCS, Faro FLS and other closed formats are refused ' +
    '(SCN_FORMAT_PROPRIETARY): export E57 from the vendor tool. Errors: SCN_E57_CHECKSUM, SCN_CLOUD_EMPTY, SCN_LAS_HEADER, SCN_ASCII_PARSE, ' +
    'NATIVE_TOOL_MISSING. CLI shorthand: llull scan import <file>.',
  inputSchema: schemaOf(
    z.object({
      path: z.string().describe('Path of the cloud file on this machine.'),
      format: z.enum(['xyz', 'pts', 'csv']).optional().describe('ASCII flavour when the extension does not say it.'),
      sourceUnit: z.enum(['m', 'mm', 'cm', 'ft', 'in']).optional().describe('Unit of ASCII coordinates (default m).'),
      columns: z.string().optional().describe('ASCII column order with x y z i r g b, _ skips a column (default xyz).'),
      applyStationPoses: z.boolean().optional().describe('E57: apply each scan pose (default true).'),
      checksum: z.enum(['all', 'sparse', 'none']).optional().describe('E57 page CRC check (default all).'),
      maxPointsPerNode: z.number().optional().describe('Octree node capacity (default 20000).'),
      timeoutS: timeoutS('Wall-clock limit in seconds (default 3600).'),
    }),
  ),
  annotations: READ_ONLY,
});

const scanList = (): ToolDefinition => ({
  name: 'scan_list',
  description: "List the point-cloud assets in this machine's store (assetKey, source name, format, points). Read-only.",
  inputSchema: EMPTY_SCHEMA,
  annotations: READ_ONLY,
});

const meshImport = (): ToolDefinition => ({
  name: 'mesh_import',
  description:
    "Import a triangle mesh file (STL ascii / binary, OBJ, PLY, 3MF) into this machine's content-addressed mesh asset store: parse, convert the unit " +
    'once into the document unit, weld, and store the canonical mesh. Prints the sourceSha256, the assetKey (sha256 of the canonical mesh) and the ' +
    'counts (triangles, vertices, open and non-manifold edges, area, volume). The document is NOT changed: attach it with attach_mesh_asset ' +
    'assetKey=<key> (the document then holds a display LOD and the key; every mesh command reads the full-resolution asset). STL, OBJ and PLY ' +
    'carry no unit, so `units` is required for them. Unverified unless `sourceSha256` pins the file. Errors: MESH_IMPORT_UNITS_REQUIRED, ' +
    'MESH_IMPORT_FORMAT_UNKNOWN, MESH_IMPORT_PARSE, MESH_IMPORT_EMPTY, MESH_IMPORT_SHA_MISMATCH. CLI shorthand: llull mesh import <file> --units mm.',
  inputSchema: schemaOf(
    z.object({
      path: z.string().describe('Path of the mesh file on this machine.'),
      units: z
        .enum(DOCUMENT_UNITS)
        .optional()
        .describe('Unit of the file coordinates; required for STL, OBJ and PLY, overrides the 3MF unit.'),
      format: z.enum(['stl', 'obj', 'ply', '3mf']).optional().describe('File format; default: sniffed from the content.'),
      weldTolerance: z
        .number()
        .positive()
        .optional()
        .describe('Vertices closer than this (document units) are merged. Default 1e-6 x bounding-box diagonal.'),
      sourceSha256: z
        .string()
        .optional()
        .describe('sha256 (hex) you expect the file to have; a match marks the asset verified, a mismatch refuses.'),
    }),
  ),
  annotations: READ_ONLY,
});

const meshAssets = (): ToolDefinition => ({
  name: 'mesh_assets',
  description:
    "List the mesh assets in this machine's store (assetKey, triangles, vertices, bounds, source file). Read-only. CLI shorthand: llull mesh list.",
  inputSchema: EMPTY_SCHEMA,
  annotations: READ_ONLY,
});

const cfdSolve = (): ToolDefinition => ({
  name: 'cfd_solve',
  description:
    'Solve a low-speed flow case (create_cfd_case, Mach < 0.3) with the native lattice-Boltzmann solver `llull-compute flow` (D3Q19 BGK + ' +
    'Smagorinsky LES, half-way bounce-back walls, far-field / slip / ground faces): runs prepare_cfd_case and refuses on any fail row, exports ' +
    'the unioned flow surface (metres, case frame), runs to steady state (time averaging once the drag settles, stop at 0.1 % change over two ' +
    'flow-throughs or at maxSteps), stores the result bundle content-addressed and records its summary with record_cfd_results. device cpu ' +
    '(default: the f64 reference, deterministic) | gpu (wgpu, f32) | auto; without a usable adapter the CPU runs with the warning CFD_GPU_UNAVAILABLE. ' +
    'A run that hits maxSteps is still recorded with converged false and the warning CFD_NOT_CONVERGED. --progress prints one line per drag ' +
    'sample. Errors: CFD_CASE_NOT_FOUND, the prepare fail codes (CFD_GEOMETRY_NOT_WATERTIGHT, CFD_BLOCKAGE_TOO_HIGH, ...), CFD_REGIME_MISMATCH ' +
    '(compressible cases: the Euler solver is not built), CFD_MEMORY_EXCEEDED (with deviceMemoryBytes), CFD_UNSTABLE_PARAMS, CFD_SOLVER_MISSING ' +
    '(no llull-compute), CFD_SOLVER_FAILED, CFD_TIMEOUT. Then: cfd_report caseId=ID, check_cfd.',
  inputSchema: schemaOf(
    z.object({
      caseId: z.string().describe('Id of the flow case (create_cfd_case).'),
      timeoutS: timeoutS('Wall-clock limit of the native job in seconds (default 3600); a killed run is lost (no checkpoint).'),
      device: deviceParam('cpu (default, deterministic f64 reference) | gpu (wgpu f32) | auto (GPU when a hardware adapter exists).'),
      deviceMemoryBytes: z
        .number()
        .optional()
        .describe('Device memory in bytes: the memory estimate is checked against it before anything is allocated (CFD_MEMORY_EXCEEDED).'),
      maxSteps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Lattice step limit, >= 1 (default 200000); reached = recorded with converged false.'),
      latticeMach: z
        .number()
        .positive()
        .max(0.3)
        .optional()
        .describe('Inflow lattice Mach number setting the time step, in (0, 0.3] (default 0.1).'),
      les: z.boolean().optional().describe('Smagorinsky LES (default true, C_s 0.1); off for laminar validation cases.'),
    }),
  ),
  annotations: {},
});

const NATIVE_TOOL_SPECS: readonly NativeToolSpec[] = [
  { name: 'fatigue_field', toolset: 'analysis', build: fatigueField },
  { name: 'fea_map_field', toolset: 'analysis', build: feaMapField },
  { name: 'fea_render', toolset: 'analysis', build: feaRender },
  { name: 'topology_solve', toolset: 'analysis', build: topologySolve },
  { name: 'explicit_run', toolset: 'analysis', build: explicitRun },
  { name: 'mtest_run', toolset: 'analysis', build: mtestRun },
  { name: 'auto_route', toolset: 'piping', build: autoRoute },
  { name: 'stackup_monte_carlo', toolset: 'pmi', build: stackupMonteCarlo },
  { name: 'vortex_lattice_solve', toolset: 'aerodynamics', build: vortexLatticeSolve },
  { name: 'scan_import', toolset: 'scan', build: scanImport },
  { name: 'scan_list', toolset: 'scan', build: scanList },
  { name: 'cfd_solve', toolset: 'flow', build: cfdSolve },
  { name: 'mesh_import', toolset: 'mesh', build: meshImport },
  { name: 'mesh_assets', toolset: 'mesh', build: meshAssets },
];

/** Every native-transport tool, schema only (read the registry, so call after the plugins are installed). */
export function buildNativeToolDefinitions(): ToolDefinition[] {
  return NATIVE_TOOL_SPECS.map((spec) => spec.build());
}

/** Names of the native transports that belong to `toolset` (for `TOOLSETS`). */
export function nativeToolNames(toolset: NativeToolset): readonly string[] {
  return NATIVE_TOOL_SPECS.filter((spec) => spec.toolset === toolset).map((spec) => spec.name);
}
