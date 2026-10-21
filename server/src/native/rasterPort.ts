/**
 * `ctx.raster` host transport (plant 09 VIS-M9, RS1 RS-5): a `RasterPort` that runs `llull-compute raster` on a render scene
 * (`job.json` "kind": "scene" + flat f64 buffers -> `rgba.bin`). Commands are synchronous, so the job runs through `runComputeSync`: the caller
 * blocks for one frame (an offscreen GPU frame is tens of milliseconds plus the process start). Installed by the CLI and the backend
 * only when the binary exists; without it `renderer: 'native'` refuses with NATIVE_TOOL_MISSING (llull stays fully usable).
 * Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_NATIVE_KEEP=1 (keep job folders).
 */

import type { RasterImage, RasterOutcome, RasterPort, RasterScene } from '@core/model/raster';
import { setRasterPort } from '@core/commands/rasterPort';
import { errorMessage } from '@lib/errorMessage';
import { computeVersionSync, f64Bytes, readOutputSync, runComputeSync, withJobFolderSync, type JobRun } from './computeJob';
import { nativeBinaryPath } from './nativeBinary';

/** Named guard: one frame of at most 2000 × 2000 at 2× supersampling stays far below this, process start included. */
const FRAME_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

type Failure = Extract<RasterOutcome, { ok: false }>;
const failure = (code: string, message: string): Failure => ({ ok: false, code, message });

function jobFiles(scene: RasterScene, engine: 'gpu' | 'cpu'): Record<string, Buffer | string> {
  const { faces, fills, loops, points, strokes, ...scalars } = scene;
  return {
    'job.json': JSON.stringify({ kind: 'scene', ...scalars, engine }),
    'faces.f64': f64Bytes(faces),
    'fills.f64': f64Bytes(fills),
    'loops.f64': f64Bytes(loops),
    'points.f64': f64Bytes(points),
    'strokes.f64': f64Bytes(strokes),
  };
}

function provenance(warnings: JobRun['warnings'], engine: 'gpu' | 'cpu', version: string): Omit<RasterImage, 'rgba'> {
  const gpu = warnings.find((warning) => warning.code === 'NATIVE_RASTER_GPU');
  if (gpu !== undefined)
    return { engine: 'native-gpu', device: /GPU \((.*)\): a picture/.exec(gpu.message)?.[1] ?? 'gpu', deterministic: false, version };
  const fallback = warnings.find((warning) => warning.code === 'NATIVE_RASTER_CPU_FALLBACK');
  const reason = engine === 'gpu' ? { reason: fallback?.message ?? 'the GPU was not used' } : {};
  return { engine: 'native-cpu', device: 'cpu', deterministic: true, version, ...reason };
}

/** A port running `binary`; `version` is read once from `--version`. */
export function createNativeRasterPort(binary: string, env: NodeJS.ProcessEnv = process.env): RasterPort {
  return {
    render(scene, engine): RasterOutcome {
      try {
        return withJobFolderSync(
          jobFiles(scene, engine),
          (folder) => {
            const run = runComputeSync(binary, ['raster', folder], folder, FRAME_TIMEOUT_MS, env, MAX_OUTPUT_BYTES);
            if (!run.ok) return failure(run.code ?? 'NATIVE_PROTOCOL', run.message ?? 'llull-compute raster failed');
            const rgba = readOutputSync(folder, run, 'rgba.bin');
            if (rgba.length !== scene.width * scene.height * 4)
              return failure('NATIVE_PROTOCOL', `rgba.bin has ${rgba.length} bytes for a ${scene.width} x ${scene.height} image`);
            const version = `llull-compute ${computeVersionSync(binary)}`;
            return { ok: true, image: { rgba: new Uint8Array(rgba), ...provenance(run.warnings, engine, version) } };
          },
          env,
        );
      } catch (error) {
        return failure('NATIVE_PROTOCOL', errorMessage(error));
      }
    },
  };
}

/** Installs the native raster as the process `ctx.raster` when `llull-compute` exists; returns whether it did. */
export function installRasterPort(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = nativeBinaryPath('llull-compute', env);
  setRasterPort(binary === null ? null : createNativeRasterPort(binary, env));
  return binary !== null;
}
