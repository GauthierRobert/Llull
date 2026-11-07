/**
 * What `llull-compute flow-query` answers (12 CFD M3a): `query.json` parsed and cross-checked against its binary file (`slice.bin` LLSL,
 * `streamlines.bin` LLST), turned into the report the agent reads; and the header of a solve's `field.bin` (LLFD), which the host checks
 * against the result grid before it keeps the file. Contract: `llull_flow_core::{query, field}`.
 */

import { z } from '@core/commands/schema';
import type { Vec3 } from '@core/model/types';
import { significantNumber } from '@lib/compactNumber';
import { roundDeep } from '@lib/significant';
import type { FlowQueryInput, FlowQueryOp } from './queryInput';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const STOPS = ['not_traced', 'left_domain', 'wall', 'stagnation', 'max_length', 'max_steps'] as const;

const probeAnswer = z.object({
  probes: z.array(
    z.object({
      pointM: vec3,
      velocityMS: vec3.nullable(),
      speedMS: z.number().nullable(),
      pressurePa: z.number().nullable(),
      miss: z.enum(['outside', 'solid']).nullable(),
    }),
  ),
});

const sliceAnswer = z.object({
  slice: z.object({
    file: z.literal('slice.bin'),
    field: z.string(),
    samples: z.number().int().positive(),
    spacingM: z.number(),
    originM: vec3,
    axisU: vec3,
    axisV: vec3,
    validSamples: z.number().int().nonnegative(),
    min: z.number().nullable(),
    max: z.number().nullable(),
  }),
});

const streamlinesAnswer = z.object({
  streamlines: z.object({
    file: z.literal('streamlines.bin'),
    device: z.enum(['cpu', 'gpu']),
    adapter: z.string().optional(),
    deterministic: z.boolean(),
    precision: z.string(),
    gpuFallback: z.string().optional(),
    points: z.number().int().nonnegative(),
    lines: z.array(
      z.object({
        seed: z.number().int().nonnegative(),
        points: z.number().int().nonnegative(),
        lengthM: z.number(),
        stopBackward: z.enum(STOPS),
        stopForward: z.enum(STOPS),
      }),
    ),
  }),
});

type ProbeAnswer = z.infer<typeof probeAnswer>;
type SliceAnswer = z.infer<typeof sliceAnswer>;
type StreamlinesAnswer = z.infer<typeof streamlinesAnswer>;

export type FlowQueryAnswer =
  | { readonly op: 'probe'; readonly answer: ProbeAnswer }
  | { readonly op: 'slice'; readonly answer: SliceAnswer }
  | { readonly op: 'streamlines'; readonly answer: StreamlinesAnswer };

const u32 = (bytes: Uint8Array, at: number): number =>
  at + 4 <= bytes.length ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true) : -1;

const magic = (bytes: Uint8Array, text: string): boolean => [...text].every((char, k) => bytes[k] === char.charCodeAt(0));

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

/**
 * `query.json` of `op` with its file, or what is wrong.
 * @invariant a slice file holds exactly samples² floats; a streamline file holds the lines and points query.json counts
 */
export function parseFlowQueryAnswer(op: FlowQueryOp, text: string, file: Uint8Array): FlowQueryAnswer | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'query.json is not JSON';
  }
  if (op === 'probe') {
    const parsed = probeAnswer.safeParse(value);
    return parsed.success ? { op, answer: parsed.data } : `query.json: ${issues(parsed.error)}`;
  }
  if (op === 'slice') {
    const parsed = sliceAnswer.safeParse(value);
    if (!parsed.success) return `query.json: ${issues(parsed.error)}`;
    const { samples } = parsed.data.slice;
    if (!magic(file, 'LLSL') || u32(file, 8) !== samples || file.length !== 72 + 4 * samples * samples)
      return `slice.bin is not an LLSL patch of ${samples} x ${samples} samples`;
    return { op, answer: parsed.data };
  }
  const parsed = streamlinesAnswer.safeParse(value);
  if (!parsed.success) return `query.json: ${issues(parsed.error)}`;
  const { lines, points } = parsed.data.streamlines;
  const counted = lines.reduce((sum, line) => sum + line.points, 0);
  if (counted !== points) return `query.json counts ${points} points, its lines ${counted}`;
  if (
    !magic(file, 'LLST') ||
    u32(file, 8) !== lines.length ||
    u32(file, 12) !== points ||
    file.length !== 16 + 4 * (lines.length + 1) + 16 * points
  )
    return `streamlines.bin is not an LLST file of ${lines.length} lines and ${points} points`;
  return { op, answer: parsed.data };
}

export interface FieldHeader {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cellM: number;
  readonly originM: Vec3;
  readonly mirrors: number;
}

/** The header of a `field.bin` whose length matches it, or what is wrong. */
export function flowFieldHeader(bytes: Uint8Array): FieldHeader | string {
  if (bytes.length < 56 || !magic(bytes, 'LLFD')) return 'field.bin does not start with an LLFD header';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 1) return `field.bin version ${view.getUint32(4, true)} is not 1`;
  const [nx, ny, nz] = [view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true)];
  const cellM = view.getFloat64(20, true);
  const originM: Vec3 = [view.getFloat64(28, true), view.getFloat64(36, true), view.getFloat64(44, true)];
  const mirrors = view.getUint32(52, true);
  const expected = 56 + 16 * mirrors + 17 * nx * ny * nz;
  if (mirrors > 3 || bytes.length !== expected) return `field.bin holds ${bytes.length} bytes, its header declares ${expected}`;
  return { nx, ny, nz, cellM, originM, mirrors };
}

/** Per-file facts the host adds (the stored file's hash and size). */
export interface StoredFile {
  readonly sha256: string;
  readonly bytes: number;
}

const range = (values: readonly number[], unit: string): string => {
  if (values.length === 0) return 'none';
  const [lo, hi] = [Math.min(...values), Math.max(...values)];
  return `${significantNumber(lo, 4)}..${significantNumber(hi, 4)} ${unit}`;
};

/** The summary line and data of an answered query. */
export function flowQueryReport(
  input: FlowQueryInput,
  answered: FlowQueryAnswer,
  stored: StoredFile | null,
): { readonly summary: string; readonly data: Readonly<Record<string, unknown>> } {
  const { caseId, resultsHash, artifact } = input;
  const base = { caseId, resultsHash, ...(input.defaults.length > 0 ? { defaults: input.defaults } : {}) };
  const tag = `result ${resultsHash.slice(0, 12)}`;
  const file = stored === null ? {} : { file: { ...stored, format: answered.op === 'slice' ? 'LLSL' : 'LLST' } };
  if (answered.op === 'probe') {
    const { dynamicPressurePa: q, speedMS: speed } = artifact.flow;
    const probes = answered.answer.probes.map((probe) => ({
      ...probe,
      cp: probe.pressurePa === null ? null : probe.pressurePa / q,
      speedRatio: probe.speedMS === null ? null : probe.speedMS / speed,
    }));
    const fluid = probes.filter((probe) => probe.miss === null);
    const count = (miss: 'outside' | 'solid'): number => probes.filter((probe) => probe.miss === miss).length;
    return {
      summary: `cfd_probe ${caseId}: ${probes.length} points — ${fluid.length} in the fluid (speed ${range(
        fluid.flatMap((probe) => (probe.speedMS === null ? [] : [probe.speedMS])),
        'm/s',
      )}, p ${range(
        fluid.flatMap((probe) => (probe.pressurePa === null ? [] : [probe.pressurePa])),
        'Pa',
      )}), ${count('solid')} in a body, ${count('outside')} outside the domain (${tag}).`,
      data: roundDeep({ ...base, probes, freeStreamSpeedMS: speed, dynamicPressurePa: q }, 10),
    };
  }
  if (answered.op === 'slice') {
    const slice = answered.answer.slice;
    const values = slice.min === null || slice.max === null ? [] : [slice.min, slice.max];
    const unit = slice.field === 'p' ? 'Pa' : slice.field === 'cp' ? '' : 'm/s';
    return {
      summary:
        `cfd_slice ${caseId}: ${slice.field} on a ${slice.samples} x ${slice.samples} patch at ${significantNumber(slice.spacingM, 4)} m, ` +
        `${slice.validSamples} samples in the fluid, ${range(values, unit).trim()}` +
        `${stored === null ? '' : `; file ${stored.sha256.slice(0, 12)} (${stored.bytes} bytes)`} (${tag}).`,
      data: roundDeep({ ...base, slice: Object.fromEntries(Object.entries(slice).filter(([key]) => key !== 'file')), ...file }, 10),
    };
  }
  const traced = answered.answer.streamlines;
  const stopCounts: Record<string, number> = {};
  for (const line of traced.lines)
    for (const stop of [line.stopBackward, line.stopForward]) if (stop !== 'not_traced') stopCounts[stop] = (stopCounts[stop] ?? 0) + 1;
  const drawn = traced.lines.filter((line) => line.points > 0);
  const device = traced.device === 'gpu' ? `gpu ${traced.adapter ?? ''} f32`.replace('  ', ' ') : 'cpu f64, deterministic';
  const stops = Object.entries(stopCounts)
    .map(([stop, n]) => `${stop} ${n}`)
    .join(', ');
  return {
    summary:
      `cfd_streamlines ${caseId}: ${traced.lines.length} seeds -> ${drawn.length} lines, ${traced.points} points, length ${range(
        drawn.map((line) => line.lengthM),
        'm',
      )} on ${device}; stops: ${stops === '' ? 'none' : stops}` +
      `${stored === null ? '' : `; file ${stored.sha256.slice(0, 12)} (${stored.bytes} bytes)`} (${tag}).`,
    data: roundDeep(
      {
        ...base,
        device: traced.device,
        ...(traced.adapter === undefined ? {} : { adapter: traced.adapter }),
        ...(traced.gpuFallback === undefined ? {} : { gpuFallback: traced.gpuFallback }),
        deterministic: traced.deterministic,
        precision: traced.precision,
        seeds: input.seeds,
        lines: traced.lines,
        points: traced.points,
        stopCounts,
        ...file,
      },
      10,
    ),
  };
}
