/**
 * Schema-only definitions of the flow transports added by 12 CFD M3a: cfd_stop, cfd_probe, cfd_slice, cfd_streamlines (runners in
 * `server/src/cfd`). The protocol may not import the plugin, so the query schemas are written here a second time; `tests/unit/aero/cfd/
 * queryTools.test.ts` pins them equal to the plugin's own zod schemas (`@aero/cfd/queryParams`), which validate the calls.
 */
import { toParamsSchema, vec3, z } from '@core/commands/schema';
import type { ToolDefinition } from './tools';

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;
const MAX_PROBES = 10_000;
const MAX_SEEDS = 4096;
const MAX_STEPS = 20_000;
const MAX_SLICE_SAMPLES = 512;

const caseId = z.string().describe('Id of a flow case with a recorded, current result (create_cfd_case, then cfd_solve).');
const point = (description: string): ReturnType<typeof vec3> => vec3(description);

const TRUST =
  'Refused unless the recorded result is trusted on this machine and current: CFD_NO_RESULT, CFD_RESULT_MISSING (bundle or field file not in ' +
  'the store), CFD_RESULT_HASH_MISMATCH, CFD_RESULT_STALE (the case or geometry changed since the solve: run cfd_solve again). Never changes the ' +
  'document. Errors also CFD_PARAM_INVALID, CFD_SOLVER_MISSING (no llull-compute), CFD_CANCELLED, CFD_SOLVER_FAILED.';

const cfdStop = (): ToolDefinition => ({
  name: 'cfd_stop',
  description:
    'Stop the running cfd_solve of a case in this host (the desktop backend for --app, or this CLI process): the llull-compute process tree is ' +
    'killed, every caller waiting for it gets CFD_CANCELLED and NOTHING is recorded (no partial result: the solver writes no checkpoint). ' +
    'Concurrent identical solves share one run; a caller that only stops waiting (Ctrl-C) leaves it running for the others. Errors: ' +
    'CFD_NOT_RUNNING (no solve of the case runs here; data.running lists the ones that do).',
  inputSchema: toParamsSchema(z.object({ caseId: z.string().describe('Id of the flow case whose running solves are stopped.') })),
  annotations: {},
});

const cfdProbe = (): ToolDefinition => ({
  name: 'cfd_probe',
  description:
    'Sample the recorded flow field of a case at points (world metres): time-averaged velocity (m/s, world axes), speed, gauge pressure (Pa), ' +
    'cp and the speed ratio U / U∞ (uniform inflow: the reference is the free stream), by trilinear interpolation over the fluid cells in the ' +
    'native llull-compute flow-query job; a half model samples the mirror image. miss "solid" (inside a body) or "outside" (outside the ' +
    `domain) per point. ${TRUST}`,
  inputSchema: toParamsSchema(
    z.object({
      caseId,
      points: z
        .array(point('Point [x, y, z] in metres, world axes.'))
        .min(1)
        .max(MAX_PROBES)
        .describe(`Probe points in metres, world axes (1..${MAX_PROBES}).`),
    }),
  ),
  annotations: READ_ONLY,
});

const cfdSlice = (): ToolDefinition => ({
  name: 'cfd_slice',
  description:
    'Sample the recorded flow field of a case on a square plane patch: speed, p, cp or a world velocity component on a regular grid (NaN in ' +
    'bodies and outside the domain), stored content-addressed as an LLSL file for the overlay (data.file.sha256) with the sample count, ' +
    `spacing, patch axes and the value range in data. ${TRUST}`,
  inputSchema: toParamsSchema(
    z.object({
      caseId,
      origin: point('Centre of the slice patch [x, y, z] in metres, world axes.'),
      normal: point('Plane normal [x, y, z], world axes (non-zero; normalised).'),
      field: z
        .enum(['speed', 'p', 'cp', 'ux', 'uy', 'uz'])
        .optional()
        .describe(
          'Sampled field: speed (m/s, default), p (gauge Pa), cp (p / free-stream dynamic pressure), ux / uy / uz (m/s, world axes).',
        ),
      spacingM: z
        .number()
        .positive()
        .optional()
        .describe(`Sample spacing in metres (default: the solver cell size); at most ${MAX_SLICE_SAMPLES} samples per side.`),
      extentM: z.number().positive().optional().describe('Side of the square patch in metres (default: the largest grid extent).'),
    }),
  ),
  annotations: READ_ONLY,
});

const cfdStreamlines = (): ToolDefinition => ({
  name: 'cfd_streamlines',
  description:
    'Trace streamlines in the recorded flow field of a case from a seed rake (line, plane, sphere or explicit points; at most 4096 seeds): RK4 ' +
    'on the velocity direction with a fixed arc-length step, both directions by default, stopping when a line leaves the domain, enters a body ' +
    '(wall), stagnates (speed < 1e-4 U∞), or reaches maxLengthM / maxSteps; polylines decimated to a quarter cell. Runs on the GPU (wgpu, f32) ' +
    'with device auto / gpu when an adapter exists, else on the CPU (f64, deterministic: identical output on every run). The polylines (world ' +
    'metres, speed per point) are stored content-addressed as an LLST file for the overlay (data.file.sha256); data lists each line (points, ' +
    `length, stop reasons) and the stop counts. ${TRUST}`,
  inputSchema: toParamsSchema(
    z.object({
      caseId,
      rake: z
        .discriminatedUnion('kind', [
          z.object({
            kind: z.literal('line').describe('Seeds on a straight segment.'),
            start: point('First seed [x, y, z] in metres, world axes.'),
            end: point('Last seed [x, y, z] in metres, world axes.'),
            count: z.number().int().min(1).max(MAX_SEEDS).describe('Seeds evenly spaced from start to end (1 = start only).'),
          }),
          z.object({
            kind: z.literal('plane').describe('Seeds on a regular nu x nv grid of a plane patch.'),
            centre: point('Centre of the seed grid [x, y, z] in metres, world axes.'),
            uAxis: point('Half-extent vector of the grid along u, metres (seeds span centre ± uAxis).'),
            vAxis: point('Half-extent vector of the grid along v, metres (seeds span centre ± vAxis).'),
            nu: z.number().int().min(1).describe('Seeds along u (nu × nv <= 4096).'),
            nv: z.number().int().min(1).describe('Seeds along v (nu × nv <= 4096).'),
          }),
          z.object({
            kind: z.literal('sphere').describe('Seeds on a sphere (Fibonacci lattice).'),
            centre: point('Centre [x, y, z] in metres, world axes.'),
            radiusM: z.number().positive().describe('Sphere radius in metres (> 0).'),
            count: z.number().int().min(1).max(MAX_SEEDS).describe('Seeds on the sphere (Fibonacci lattice).'),
          }),
          z.object({
            kind: z.literal('points').describe('Explicit seed points.'),
            points: z.array(point('Seed [x, y, z] in metres, world axes.')).min(1).max(MAX_SEEDS).describe('Explicit seeds.'),
          }),
        ])
        .describe(
          'Seed rake: line { start, end, count }, plane { centre, uAxis, vAxis, nu, nv }, sphere { centre, radiusM, count } or points ' +
            `{ points }; at most ${MAX_SEEDS} seeds.`,
        ),
      direction: z
        .enum(['both', 'forward', 'backward'])
        .optional()
        .describe('Trace downstream (forward), upstream (backward) or both from each seed (default both).'),
      stepM: z.number().positive().optional().describe('RK4 arc-length step in metres (default half the solver cell; at most one cell).'),
      maxLengthM: z.number().positive().optional().describe('Length limit per direction in metres (default 3 domain lengths).'),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .max(MAX_STEPS)
        .optional()
        .describe(`Step limit per direction, 1..${MAX_STEPS} (default maxLengthM / stepM, capped).`),
      device: z
        .enum(['cpu', 'gpu', 'auto'])
        .optional()
        .describe(
          'auto (default: the GPU when a hardware adapter exists, f32), gpu (CFD_GPU_UNAVAILABLE warning and CPU without one), cpu (f64, deterministic).',
        ),
    }),
  ),
  annotations: READ_ONLY,
});

/** The M3a flow transports, in palette order. */
export const CFD_QUERY_TOOL_BUILDERS: readonly { readonly name: string; readonly build: () => ToolDefinition }[] = [
  { name: 'cfd_stop', build: cfdStop },
  { name: 'cfd_probe', build: cfdProbe },
  { name: 'cfd_slice', build: cfdSlice },
  { name: 'cfd_streamlines', build: cfdStreamlines },
];
