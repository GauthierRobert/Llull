/**
 * Native `FieldEngine` (05 IMP M4, RS1): `mesh`, `measure` and `evaluate` (values) run `llull-compute field` on a job folder (`job.json` + little-endian
 * f64 / u32 files, contract in `solver/crates/llull-field/src/lib.rs`). The Rust code reproduces the TypeScript engine (`tsEngine.ts`) bit for bit
 * (V8-exact sin / cos / atan2 / exp / log / hypot, same scan and numbering orders), so `deterministic: true`, and it lifts the TS caps (`limits`).
 * Commands are synchronous, so a job BLOCKS the backend event loop for its duration (TECHNICAL_SPEC D9); the cap is the timeout below.
 * A job that cannot run (binary missing, crash, timeout, protocol) is answered by the TS engine when the request fits its caps, else refused
 * with IMP_ENGINE_FAILED naming the reason. Gradients are always answered by the TS engine.
 * Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_FIELD_TIMEOUT_S (default 600), LLULL_NATIVE_KEEP=1.
 */

import type { MeshData } from '@core/model/types';
import { setFieldEngine } from '@core/geometry/field/engine';
import {
  type FieldEngine,
  type FieldGrid,
  type FieldProvenance,
  type FieldRefusal,
  type FieldSamples,
  type MeasureRequest,
  type MeshOptions,
  gridCells,
} from '@core/geometry/field/engineTypes';
import { type FieldProgram, programError } from '@core/geometry/field/program';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { isRecord } from '@lib/isRecord';
import { computeVersionSync, f64Bytes, f64Values, readOutputSync, runComputeSync, withJobFolderSync } from './computeJob';
import { nativeBinaryPath } from './nativeBinary';

const DEFAULT_TIMEOUT_S = 600;
/** Named guard: the done event, a handful of progress events and the output list are all that reaches stdout. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Measured caps (TECHNICAL_SPEC 14.2): grid nodes the streamed mesher admits, and the triangle budget shared with the TS engine. */
export const NATIVE_FIELD_LIMITS: FieldEngine['limits'] = { maxSamples: 2 ** 30, maxTriangles: 5_000_000, maxStoredTriangles: 20_000_000 };

type Files = Record<string, Buffer | string>;

class FieldJobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const u32Bytes = (values: readonly number[]): Buffer => {
  const out = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, i) => out.writeUInt32LE(value, i * 4));
  return out;
};

/** The JSON part of `program` and its binary operands under `prefix` (`` or `region_`). */
function packProgram(program: FieldProgram, prefix: string, files: Files): Record<string, unknown> {
  files[`${prefix}constants.f64`] = f64Bytes(Float64Array.from(program.constants));
  program.meshes.forEach((entry, index) => {
    files[`${prefix}mesh${index}_positions.f64`] = f64Bytes(Float64Array.from(entry.mesh.positions));
    files[`${prefix}mesh${index}_indices.u32`] = u32Bytes(entry.mesh.indices);
  });
  program.strutSets.forEach((set, index) => {
    files[`${prefix}strut${index}_nodes.f64`] = f64Bytes(Float64Array.from(set.nodes.flat()));
    files[`${prefix}strut${index}_beams.f64`] = f64Bytes(
      Float64Array.from(set.beams.flatMap((beam) => [beam.a, beam.b, beam.ra, beam.rb, beam.cap === 'sphere' ? 1 : 0])),
    );
  });
  return {
    instructions: program.instructions.map((instruction) => ({ op: instruction.op, args: [...instruction.args] })),
    output: program.output,
    meshes: program.meshes.length,
    strutSets: program.strutSets.map((set) => ({
      periodic: set.periodic === null ? null : { cell: [...set.periodic.cell], origin: [...set.periodic.origin] },
      nodes: set.nodes.length,
      beams: set.beams.length,
    })),
  };
}

const timeoutMsOf = (env: NodeJS.ProcessEnv): number => {
  const seconds = Number(env['LLULL_FIELD_TIMEOUT_S']);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_S) * 1000;
};

interface JobResult {
  readonly report: Record<string, unknown>;
  readonly folder: string;
  readonly read: (name: string) => Buffer;
}

export interface NativeFieldEngineOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Absolute path of llull-compute (default: located like every native job). */
  readonly binary?: string;
}

const refusal = (code: FieldRefusal['code'], message: string, samples?: number, limit?: number): FieldRefusal => ({
  ok: false,
  code,
  message,
  ...(samples === undefined ? {} : { samples }),
  ...(limit === undefined ? {} : { limit }),
});

function refusalOf(report: Record<string, unknown>): FieldRefusal | null {
  const found = report['refusal'];
  if (!isRecord(found)) return null;
  const code = found['code'];
  const known = code === 'IMP_GRID_BUDGET' || code === 'IMP_TRIANGLE_BUDGET' || code === 'IMP_ENGINE_FAILED';
  const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  return refusal(
    known ? code : 'IMP_ENGINE_FAILED',
    String(found['message'] ?? 'the native field engine refused'),
    number(found['samples']),
    number(found['limit']),
  );
}

const num = (value: unknown): number => (typeof value === 'number' ? value : NaN);

/** The native engine, or null when `llull-compute` is not installed. */
export function createNativeFieldEngine(options: NativeFieldEngineOptions = {}): FieldEngine | null {
  const env = options.env ?? process.env;
  const binary = options.binary ?? nativeBinaryPath('llull-compute', env);
  if (binary === null) return null;
  const timeoutMs = timeoutMsOf(env);
  const provenance = (voxel: number): FieldProvenance => ({
    engine: 'llull-field',
    device: `cpu (llull-compute@${computeVersionSync(binary)})`,
    deterministic: true,
    voxel,
  });

  const job = <T>(files: Files, body: (result: JobResult) => T): T =>
    withJobFolderSync(
      files,
      (folder) => {
        const run = runComputeSync(binary, ['field', folder], folder, timeoutMs, env, MAX_OUTPUT_BYTES);
        if (!run.ok) throw new FieldJobFailure(run.code ?? 'NATIVE_JOB_FAILED', `${run.code ?? 'failed'}: ${run.message ?? ''}`.trim());
        const read = (name: string): Buffer => readOutputSync(folder, run, name);
        let report: unknown;
        try {
          report = JSON.parse(read('report.json').toString('utf8'));
        } catch (error) {
          throw new FieldJobFailure('NATIVE_PROTOCOL', `unreadable report.json: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!isRecord(report)) throw new FieldJobFailure('NATIVE_PROTOCOL', 'report.json is not an object');
        return body({ report, folder, read });
      },
      env,
    );

  /** `native()`; on a job failure the TS answer when the request fits its caps, else IMP_ENGINE_FAILED with the reason. */
  const guarded = <T>(samples: number, native: () => T, fallback: () => T, refuse: (r: FieldRefusal) => T): T => {
    try {
      return native();
    } catch (error) {
      const reason = error instanceof FieldJobFailure ? error.message : error instanceof Error ? error.message : String(error);
      console.warn(
        `[llull-field] native job failed (${reason}); `,
        samples <= tsFieldEngine.limits.maxSamples ? 'answering with the TS engine' : 'refusing',
      );
      return samples <= tsFieldEngine.limits.maxSamples
        ? fallback()
        : refuse(
            refusal(
              'IMP_ENGINE_FAILED',
              `the native field engine failed (${reason}) and the request exceeds the TS engine's ${tsFieldEngine.limits.maxSamples} samples`,
            ),
          );
    }
  };

  const engine: FieldEngine = {
    name: 'llull-field',
    limits: NATIVE_FIELD_LIMITS,
    evaluate(program, points, withGradient): FieldSamples {
      if (withGradient || programError(program) !== null) return tsFieldEngine.evaluate(program, points, withGradient);
      const count = Math.floor(points.length / 3);
      const empty = { values: new Float64Array(0), gradients: null, nonFinite: 0 };
      return guarded<FieldSamples>(
        count,
        () => {
          const files: Files = {};
          const spec = packProgram(program, '', files);
          files['points.f64'] = f64Bytes(points.subarray(0, count * 3));
          files['job.json'] = JSON.stringify({ op: 'evaluate', program: spec, points: count });
          return job(files, ({ report, read }) => {
            const values = f64Values(read('values.f64'));
            if (values.length !== count) throw new FieldJobFailure('NATIVE_PROTOCOL', `${values.length} values for ${count} points`);
            return { values, gradients: null, nonFinite: num(report['nonFiniteSamples']) };
          });
        },
        () => tsFieldEngine.evaluate(program, points, false),
        (r) => ({
          ...empty,
          values: new Float64Array(count).fill(NaN),
          nonFinite: count,
          failure: { code: 'IMP_ENGINE_FAILED', message: r.message },
        }),
      );
    },

    mesh(program, grid: FieldGrid, meshOptions: MeshOptions) {
      if (meshOptions.mesher !== 'tetra' || programError(program) !== null) return tsFieldEngine.mesh(program, grid, meshOptions);
      const [nx, ny, nz] = gridCells(grid);
      const nodes = (nx + 1) * (ny + 1) * (nz + 1);
      if (!(nodes <= Number.MAX_SAFE_INTEGER))
        return refusal('IMP_GRID_BUDGET', `${nodes} grid samples`, nodes, NATIVE_FIELD_LIMITS.maxSamples);
      return guarded<ReturnType<FieldEngine['mesh']>>(
        nodes,
        () => {
          const files: Files = {};
          const spec = packProgram(program, '', files);
          files['job.json'] = JSON.stringify({
            op: 'mesh',
            program: spec,
            grid: { min: [...grid.min], max: [...grid.max], voxel: grid.voxel },
            maxSamples: NATIVE_FIELD_LIMITS.maxSamples,
            maxTriangles: meshOptions.maxTriangles,
          });
          return job(files, ({ report, read }) => {
            const refused = refusalOf(report);
            if (refused !== null) return refused;
            const positions = f64Values(read('positions.f64'));
            const indexBytes = read('indices.u32');
            const indices = new Array<number>(indexBytes.length / 4);
            for (let i = 0; i < indices.length; i += 1) indices[i] = indexBytes.readUInt32LE(i * 4);
            const mesh: MeshData = { positions: Array.from(positions), indices };
            return {
              ok: true as const,
              mesh,
              closedManifold: report['closedManifold'] === true,
              samples: num(report['samples']),
              evaluatedSamples: num(report['evaluatedSamples']),
              prunedFraction: num(report['prunedFraction']),
              maxVertexResidual: num(report['maxVertexResidual']),
              nonFiniteSamples: num(report['nonFiniteSamples']),
              mesher: 'tetra',
              mesherFallback: false,
              provenance: provenance(grid.voxel),
            };
          });
        },
        () => tsFieldEngine.mesh(program, grid, meshOptions),
        (r) => r,
      );
    },

    measure(program, grid: FieldGrid, region: FieldProgram | null, request: MeasureRequest) {
      if (programError(program) !== null || (region !== null && programError(region) !== null))
        return tsFieldEngine.measure(program, grid, region, request);
      const [nx, ny, nz] = gridCells(grid);
      const samples = request.kind === 'components' || request.kind === 'nodes' ? (nx + 1) * (ny + 1) * (nz + 1) : nx * ny * nz;
      return guarded<ReturnType<FieldEngine['measure']>>(
        samples,
        () => {
          const files: Files = {};
          const spec = packProgram(program, '', files);
          const regionSpec = region === null ? null : packProgram(region, 'region_', files);
          files['job.json'] = JSON.stringify({
            op: 'measure',
            program: spec,
            region: regionSpec,
            grid: { min: [...grid.min], max: [...grid.max], voxel: grid.voxel },
            maxSamples: NATIVE_FIELD_LIMITS.maxSamples,
            request,
          });
          return job(files, ({ report, read }) => {
            const refused = refusalOf(report);
            if (refused !== null) return refused;
            const common = { ok: true as const, samples: num(report['samples']), provenance: provenance(grid.voxel) };
            if (request.kind === 'volume')
              return {
                ...common,
                kind: 'volume' as const,
                volume: num(report['volume']),
                regionVolume: num(report['regionVolume']),
                nonFiniteSamples: num(report['nonFiniteSamples']),
              };
            if (request.kind === 'quantile') {
              const values = Array.isArray(report['values']) ? report['values'].map((v) => (typeof v === 'number' ? v : NaN)) : [];
              return { ...common, kind: 'quantile' as const, values };
            }
            if (request.kind === 'nodes') {
              const nodes = Array.isArray(report['nodes']) ? report['nodes'].map(num) : [];
              const inside = Uint8Array.from(read('nodes.u8'));
              if (nodes.length !== 3 || inside.length !== nodes.reduce((a, b) => a * b, 1))
                throw new FieldJobFailure('NATIVE_PROTOCOL', `nodes.u8 holds ${inside.length} flags for grid ${JSON.stringify(nodes)}`);
              return {
                ...common,
                kind: 'nodes' as const,
                inside,
                nodes: [nodes[0] as number, nodes[1] as number, nodes[2] as number] as const,
              };
            }
            const components = (key: string): ReturnType<typeof componentOf>[] =>
              Array.isArray(report[key]) ? report[key].map(componentOf) : [];
            return { ...common, kind: 'components' as const, solids: components('solids'), voids: components('voids') };
          });
        },
        () => tsFieldEngine.measure(program, grid, region, request),
        (r) => r,
      );
    },
  };
  return engine;
}

function componentOf(entry: unknown): { voxels: number; volume: number; point: [number, number, number]; enclosed: boolean } {
  const e = isRecord(entry) ? entry : {};
  const p = Array.isArray(e['point']) ? e['point'] : [];
  return { voxels: num(e['voxels']), volume: num(e['volume']), point: [num(p[0]), num(p[1]), num(p[2])], enclosed: e['enclosed'] === true };
}

/** Installs the native engine as the process `ctx.fieldEngine` when `llull-compute` exists; returns whether it did. */
export function installFieldEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  const engine = createNativeFieldEngine({ env });
  setFieldEngine(engine);
  return engine !== null;
}
