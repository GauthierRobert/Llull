/**
 * `result.json` of `llull-compute flow` -> the `cfd_result` artifact the host stores (TECHNICAL_SPEC §6, M2). The solver's own
 * coefficients are cross-checked against its forces with the case reference before the artifact is accepted.
 */

import { z } from '@core/commands/schema';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { uint8ArrayToBase64 } from '@lib/base64';
import type { FlowJob } from './flowJob';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const resultSchema = z.object({
  version: z.literal(1),
  caseId: z.string(),
  solver: z.literal('lbm'),
  converged: z.boolean(),
  steps: z.number().int().nonnegative(),
  averagedSteps: z.number().int().nonnegative(),
  timeS: z.number(),
  elapsedS: z.number(),
  device: z.enum(['cpu', 'gpu']),
  adapter: z.string().optional(),
  deterministic: z.boolean(),
  precision: z.string(),
  halfModel: z.boolean(),
  memory: z.object({
    bytesPerCell: z.number().int(),
    gpuBytesPerCell: z.number().int(),
    cpuBytesPerCell: z.number().int(),
    bytes: z.number().int(),
  }),
  grid: z.object({
    nx: z.number().int(),
    ny: z.number().int(),
    nz: z.number().int(),
    cellM: z.number(),
    cells: z.number().int(),
    fluidCells: z.number().int(),
    solidCells: z.number().int(),
    originM: vec3,
  }),
  lattice: z.object({
    tau: z.number(),
    uLattice: z.number(),
    dtS: z.number(),
    flowThroughSteps: z.number().int(),
    les: z.boolean(),
    smagorinsky: z.number(),
    reynolds: z.number(),
  }),
  forces: z.object({
    totalN: vec3,
    momentNm: vec3,
    dragN: z.number(),
    liftN: z.number(),
    sideN: z.number(),
    cd: z.number(),
    cl: z.number(),
    cs: z.number(),
    cm: vec3,
    cdAM2: z.number(),
    dynamicPressurePa: z.number(),
    dragAxis: vec3,
    liftAxis: vec3,
    sideAxis: vec3,
  }),
  perBody: z.array(z.object({ entityId: z.string(), forceN: vec3 })),
  peaks: z.array(z.object({ field: z.string(), min: z.number(), max: z.number(), minAt: vec3, maxAt: vec3, unit: z.string() })),
  probes: z.array(
    z.object({ pointM: vec3, velocityMS: vec3.nullable(), speedMS: z.number().nullable(), pressurePa: z.number().nullable() }),
  ),
  history: z.array(
    z.object({
      step: z.number().int(),
      timeS: z.number(),
      dragN: z.number(),
      cd: z.number(),
      forceN: vec3,
      change: z.number().nullable(),
      phase: z.enum(['transient', 'averaging']),
    }),
  ),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  notModelled: z.array(z.string()),
  slices: z.array(z.string()),
});

export type FlowResultJson = z.infer<typeof resultSchema>;

/** Parses `result.json`; a string names what is wrong. */
export function parseFlowResult(text: string): FlowResultJson | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'result.json is not JSON';
  }
  const parsed = resultSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : `result.json: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`;
}

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

/**
 * The artifact of a finished run.
 * @invariant the solver's cd / cl / cs / cm equal the ones recomputed here from its forces and the job's reference (1e-9 relative)
 * @failure another case id, or disagreeing coefficients -> an explanation instead of an artifact
 */
export function flowResultArtifact(
  result: FlowResultJson,
  job: FlowJob,
  files: { readonly surface: Uint8Array; readonly slices: readonly { readonly name: string; readonly bytes: Uint8Array }[] },
  solverVersion: string,
): CfdResultArtifact | string {
  if (result.caseId !== job.caseJson.caseId) return `result.json is for case '${result.caseId}', the job was '${job.caseJson.caseId}'`;
  const { reference, flow } = job.caseJson;
  const q = 0.5 * flow.densityKgM3 * flow.speedMS * flow.speedMS;
  const qArea = q * reference.areaM2;
  const expected = {
    cd: dot(result.forces.totalN, result.forces.dragAxis) / qArea,
    cl: dot(result.forces.totalN, result.forces.liftAxis) / qArea,
    cs: dot(result.forces.totalN, result.forces.sideAxis) / qArea,
  };
  const scale = Math.max(Math.abs(expected.cd), Math.abs(expected.cl), Math.abs(expected.cs), 1e-12);
  const disagreeing = (['cd', 'cl', 'cs'] as const).filter((key) => Math.abs(result.forces[key] - expected[key]) > 1e-9 * scale);
  if (disagreeing.length > 0) return `the solver's ${disagreeing.join(', ')} disagree with its forces and the case reference`;
  if (Math.abs(result.forces.dynamicPressurePa - q) > 1e-9 * Math.max(q, 1e-12))
    return "the solver's dynamic pressure disagrees with the case free stream";
  return {
    kind: 'cfd_result',
    caseId: result.caseId,
    caseHash: job.caseHash,
    geometryHash: job.geometryHash,
    kernel: job.kernel,
    solver: 'lbm',
    solverVersion,
    converged: result.converged,
    steps: result.steps,
    averagedSteps: result.averagedSteps,
    timeS: result.timeS,
    elapsedS: result.elapsedS,
    device: result.device,
    ...(result.adapter === undefined ? {} : { adapter: result.adapter }),
    deterministic: result.deterministic,
    precision: result.precision,
    halfModel: result.halfModel,
    memory: result.memory,
    grid: result.grid,
    lattice: result.lattice,
    flow: { speedMS: flow.speedMS, densityKgM3: flow.densityKgM3, dynamicPressurePa: q, direction: flow.direction },
    forces: {
      totalN: result.forces.totalN,
      momentNm: result.forces.momentNm,
      dragAxis: result.forces.dragAxis,
      liftAxis: result.forces.liftAxis,
      sideAxis: result.forces.sideAxis,
    },
    perBody: result.perBody,
    peaks: result.peaks,
    probes: result.probes,
    history: result.history,
    warnings: result.warnings,
    notModelled: result.notModelled,
    defaults: job.defaults,
    surfaceBase64: uint8ArrayToBase64(files.surface),
    slices: files.slices.map((slice) => ({ name: slice.name, base64: uint8ArrayToBase64(slice.bytes) })),
  };
}
