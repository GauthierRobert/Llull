/**
 * Params of the result-query transports `cfd_probe`, `cfd_slice`, `cfd_streamlines` (12 CFD M3a, TECHNICAL_SPEC §4 / §5.5): one zod schema
 * per transport (validation here; `@protocol/cfdTools` publishes the same JSON Schema, pinned by a test), and the streamline rakes. Points,
 * normals and rake geometry are WORLD metres (like the case's probes); the job converts to the case frame of the stored field.
 */

import { vec3, z } from '@core/commands/schema';
import type { Vec3 } from '@core/model/types';

/** Named caps (the native job refuses above them too: `llull_flow_core::query`). */
export const CFD_QUERY_LIMITS = { maxProbes: 10_000, maxSeeds: 4096, maxSteps: 20_000, maxSliceSamples: 512 } as const;

const caseId = z.string().describe('Id of a flow case with a recorded, current result (create_cfd_case, then cfd_solve).');
const point = (description: string): ReturnType<typeof vec3> => vec3(description);

export const cfdProbeParams = z.object({
  caseId,
  points: z
    .array(point('Point [x, y, z] in metres, world axes.'))
    .min(1)
    .max(CFD_QUERY_LIMITS.maxProbes)
    .describe(`Probe points in metres, world axes (1..${CFD_QUERY_LIMITS.maxProbes}).`),
});

export const SLICE_FIELDS = ['speed', 'p', 'cp', 'ux', 'uy', 'uz'] as const;

export const cfdSliceParams = z.object({
  caseId,
  origin: point('Centre of the slice patch [x, y, z] in metres, world axes.'),
  normal: point('Plane normal [x, y, z], world axes (non-zero; normalised).'),
  field: z
    .enum(SLICE_FIELDS)
    .optional()
    .describe('Sampled field: speed (m/s, default), p (gauge Pa), cp (p / free-stream dynamic pressure), ux / uy / uz (m/s, world axes).'),
  spacingM: z
    .number()
    .positive()
    .optional()
    .describe(`Sample spacing in metres (default: the solver cell size); at most ${CFD_QUERY_LIMITS.maxSliceSamples} samples per side.`),
  extentM: z.number().positive().optional().describe('Side of the square patch in metres (default: the largest grid extent).'),
});

const lineRake = z.object({
  kind: z.literal('line').describe('Seeds on a straight segment.'),
  start: point('First seed [x, y, z] in metres, world axes.'),
  end: point('Last seed [x, y, z] in metres, world axes.'),
  count: z.number().int().min(1).max(CFD_QUERY_LIMITS.maxSeeds).describe('Seeds evenly spaced from start to end (1 = start only).'),
});

const planeRake = z.object({
  kind: z.literal('plane').describe('Seeds on a regular nu x nv grid of a plane patch.'),
  centre: point('Centre of the seed grid [x, y, z] in metres, world axes.'),
  uAxis: point('Half-extent vector of the grid along u, metres (seeds span centre ± uAxis).'),
  vAxis: point('Half-extent vector of the grid along v, metres (seeds span centre ± vAxis).'),
  nu: z.number().int().min(1).describe('Seeds along u (nu × nv <= 4096).'),
  nv: z.number().int().min(1).describe('Seeds along v (nu × nv <= 4096).'),
});

const sphereRake = z.object({
  kind: z.literal('sphere').describe('Seeds on a sphere (Fibonacci lattice).'),
  centre: point('Centre [x, y, z] in metres, world axes.'),
  radiusM: z.number().positive().describe('Sphere radius in metres (> 0).'),
  count: z.number().int().min(1).max(CFD_QUERY_LIMITS.maxSeeds).describe('Seeds on the sphere (Fibonacci lattice).'),
});

const pointsRake = z.object({
  kind: z.literal('points').describe('Explicit seed points.'),
  points: z.array(point('Seed [x, y, z] in metres, world axes.')).min(1).max(CFD_QUERY_LIMITS.maxSeeds).describe('Explicit seeds.'),
});

export const cfdStreamlinesParams = z.object({
  caseId,
  rake: z
    .discriminatedUnion('kind', [lineRake, planeRake, sphereRake, pointsRake])
    .describe(
      'Seed rake: line { start, end, count }, plane { centre, uAxis, vAxis, nu, nv }, sphere { centre, radiusM, count } or points ' +
        `{ points }; at most ${CFD_QUERY_LIMITS.maxSeeds} seeds.`,
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
    .max(CFD_QUERY_LIMITS.maxSteps)
    .optional()
    .describe(`Step limit per direction, 1..${CFD_QUERY_LIMITS.maxSteps} (default maxLengthM / stepM, capped).`),
  device: z
    .enum(['cpu', 'gpu', 'auto'])
    .optional()
    .describe(
      'auto (default: the GPU when a hardware adapter exists, f32), gpu (CFD_GPU_UNAVAILABLE warning and CPU without one), cpu (f64, deterministic).',
    ),
});

export type CfdProbeParams = z.infer<typeof cfdProbeParams>;
export type CfdSliceParams = z.infer<typeof cfdSliceParams>;
export type CfdStreamlinesParams = z.infer<typeof cfdStreamlinesParams>;
type Rake = CfdStreamlinesParams['rake'];

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Seeds of a rake (world metres), or why it has none: a plane over the seed cap. */
export function rakeSeeds(rake: Rake): Vec3[] | string {
  switch (rake.kind) {
    case 'line':
      return [...Array(rake.count).keys()].map((k) => (rake.count === 1 ? rake.start : lerp(rake.start, rake.end, k / (rake.count - 1))));
    case 'plane': {
      if (rake.nu * rake.nv > CFD_QUERY_LIMITS.maxSeeds)
        return `a plane rake of ${rake.nu} x ${rake.nv} seeds exceeds ${CFD_QUERY_LIMITS.maxSeeds}`;
      const at = (k: number, n: number): number => (n === 1 ? 0 : (2 * k) / (n - 1) - 1);
      const [c, u, v] = [rake.centre, rake.uAxis, rake.vAxis];
      const seeds: Vec3[] = [];
      for (let j = 0; j < rake.nv; j += 1)
        for (let i = 0; i < rake.nu; i += 1) {
          const [s, t] = [at(i, rake.nu), at(j, rake.nv)];
          seeds.push([c[0] + s * u[0] + t * v[0], c[1] + s * u[1] + t * v[1], c[2] + s * u[2] + t * v[2]]);
        }
      return seeds;
    }
    case 'sphere': {
      const golden = Math.PI * (3 - Math.sqrt(5));
      return [...Array(rake.count).keys()].map((k) => {
        const z = rake.count === 1 ? 1 : 1 - (2 * k) / (rake.count - 1);
        const ring = Math.sqrt(Math.max(0, 1 - z * z));
        const phi = golden * k;
        return [
          rake.centre[0] + rake.radiusM * ring * Math.cos(phi),
          rake.centre[1] + rake.radiusM * ring * Math.sin(phi),
          rake.centre[2] + rake.radiusM * z,
        ];
      });
    }
    case 'points':
      return rake.points.map((seed) => [seed[0], seed[1], seed[2]]);
  }
}
