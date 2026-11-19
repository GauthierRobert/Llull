/**
 * `ctx.raster` host transport (plant 09 VIS-M9, RS1 RS-5): a `RasterPort` that runs `llull-compute raster` on a render scene
 * (`job.json` "kind": "scene" + flat f64 buffers -> `rgba.bin`). Commands are synchronous, so the job runs through `runComputeSync`: the caller
 * blocks for one frame (an offscreen GPU frame is tens of milliseconds plus the process start). Installed by the CLI and the backend
 * only when the binary exists; without it `renderer: 'native'` refuses with NATIVE_TOOL_MISSING (llull stays fully usable).
 * The installed port is the persistent one (PERF1 §5 row 10): one `llull-compute raster-serve` process per host draws every frame and
 * encodes its PNG natively (`rasterProcess.ts`, `rasterFrames.ts`); a binary without `raster-serve` (it never answered a frame) falls
 * back to the job runner for the rest of the process.
 * Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_NATIVE_KEEP=1 (keep job folders), LLULL_RASTER_PROCESS=0 (job runner only).
 */

import type { RasterImage, RasterOutcome, RasterPort, RasterScene } from '@core/model/raster';
import { setRasterPort } from '@core/commands/rasterPort';
import { errorMessage } from '@lib/errorMessage';
import { computeVersionSync, f64Bytes, readOutputSync, runComputeSync, withJobFolderSync, type JobRun } from './computeJob';
import { nativeBinaryPath, nativeRuntimeEnv } from './nativeBinary';
import { encodeRasterRequest } from './rasterFrames';
import { createRasterProcess, type RasterProcess } from './rasterProcess';

/** Named guard: one frame of at most 2000 × 2000 at 2× supersampling stays far below this, process start included. */
const FRAME_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MIB = 1024 * 1024;

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

export interface PersistentRasterOptions {
  /** Executable + arguments of the server (default `<binary> raster-serve`; a fake in tests). */
  readonly command?: { readonly executable: string; readonly args: readonly string[] };
  readonly frameTimeoutMs?: number;
  /** Version reported in provenance (default: probed once from `<binary> --version`). */
  readonly version?: string;
}

export interface PersistentRasterPort extends RasterPort {
  readonly process: RasterProcess;
  /** True once the binary turned out to have no `raster-serve` and frames go through the job runner. */
  usesJobRunner(): boolean;
  close(): void;
}

/** A port drawing on one long-lived `binary raster-serve` (started on the first frame); see the module doc. */
export function createPersistentRasterPort(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  options: PersistentRasterOptions = {},
): PersistentRasterPort {
  const { LLULL_EXIT_ON_STDIN_EOF: _watchdog, ...serveEnv } = nativeRuntimeEnv(binary, env); // its stdin carries the frames
  const command = options.command ?? { executable: binary, args: ['raster-serve'] };
  const server = createRasterProcess({
    command: command.executable,
    args: command.args,
    env: serveEnv,
    frameTimeoutMs: options.frameTimeoutMs ?? FRAME_TIMEOUT_MS,
  });
  let served = false;
  let jobRunner: RasterPort | null = null;
  const version = (): string => options.version ?? `llull-compute ${computeVersionSync(binary)}`;
  return {
    process: server,
    usesJobRunner: () => jobRunner !== null,
    close: () => server.close(),
    render(scene, engine, request): RasterOutcome {
      if (jobRunner !== null) return jobRunner.render(scene, engine);
      const rgbaBytes = scene.width * scene.height * 4;
      // a compressed PNG of the image stays far below twice its raw rows (fixed Huffman: at most 9 bits per byte)
      const maxReply = rgbaBytes + (request?.png === true ? 2 * rgbaBytes + MIB : 0);
      const reply = server.request(encodeRasterRequest(scene, engine, request?.png === true), maxReply);
      if (!reply.ok) {
        // only a binary that answered with a job event (no raster-serve) switches the host to one job per frame; a crash does not
        if (!served && reply.code === 'NATIVE_NO_RASTER_SERVE') {
          console.warn(`[raster] ${binary} raster-serve did not answer (${reply.message}); drawing with one job per frame`);
          server.close();
          jobRunner = createNativeRasterPort(binary, env);
          return jobRunner.render(scene, engine);
        }
        return failure(reply.code, reply.message);
      }
      served = true;
      if (reply.rgba.length !== rgbaBytes)
        return failure('NATIVE_PROTOCOL', `the raster process returned an image of the wrong size for ${scene.width} x ${scene.height}`);
      const png = reply.png.length > 0 ? { png: reply.png } : {};
      return { ok: true, image: { rgba: reply.rgba, ...provenance(reply.warnings, engine, version()), ...png } };
    },
  };
}

let persistent: PersistentRasterPort | null = null;

/** Ends the persistent raster process of this host, if one runs (server shutdown). */
export function closeRasterPort(): void {
  persistent?.close();
}

/** Installs the native raster as the process `ctx.raster` when `llull-compute` exists; returns whether it did. */
export function installRasterPort(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = nativeBinaryPath('llull-compute', env);
  persistent?.close();
  persistent = binary === null || env['LLULL_RASTER_PROCESS'] === '0' ? null : createPersistentRasterPort(binary, env);
  setRasterPort(binary === null ? null : (persistent ?? createNativeRasterPort(binary, env)));
  return binary !== null;
}
