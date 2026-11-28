/**
 * `ctx.pathTrace` host transport (RV1 RV-M3, wire contract RV1 §5b): a `PathTracePort` that writes one job folder (job.json, the f32 / u32 /
 * f64 buffers, the texture files) and runs `llull-compute pathtrace <folder>`, then reads image.png, beauty.exr and stats.json back.
 * Commands are synchronous, so the caller blocks for the whole render (the native side stops sampling at `job.maxSeconds`; the process
 * timeout leaves room for the denoiser and the file writes). Installed by the CLI and the backend only when the binary exists.
 * Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_NATIVE_KEEP=1 (keep job folders).
 */

import { existsSync } from 'fs';
import path from 'path';
import type { PathTraceOutcome, PathTracePort, PathTraceScene, PathTraceStats } from '@core/model/pathTrace';
import { setPathTracePort } from '@core/commands/pathTracePort';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { computeVersionSync, f64Bytes, readOutputSync, runComputeSync, withJobFolderSync } from './computeJob';
import { nativeBinaryPath } from './nativeBinary';

/** Named guard: time on top of `job.maxSeconds` for the scene build, the denoiser and writing an 8192 px EXR. */
const PROCESS_MARGIN_MS = 300_000;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

type Failure = Extract<PathTraceOutcome, { ok: false }>;
const failure = (code: string, message: string): Failure => ({ ok: false, code, message });

const bytesOf = (view: ArrayBufferView): Buffer => Buffer.from(view.buffer, view.byteOffset, view.byteLength);

/** The files of one job folder. */
export function pathTraceJobFiles(scene: PathTraceScene): Record<string, Buffer | string> {
  const files: Record<string, Buffer | string> = {
    'job.json': JSON.stringify(scene.job),
    'positions.f32': bytesOf(scene.positions),
    'normals.f32': bytesOf(scene.normals),
    'uvs.f32': bytesOf(scene.uvs),
    'indices.u32': bytesOf(scene.indices),
    'instances.f64': f64Bytes(scene.instances),
  };
  scene.job.textures.forEach((texture, index) => {
    const bytes = scene.textureBytes[index];
    if (bytes !== undefined) files[texture.file] = Buffer.from(bytes);
  });
  return files;
}

const STOPS: ReadonlySet<string> = new Set(['samples', 'noise', 'time']);

/** `stats.json` checked field by field; throws on a malformed file. */
export function parsePathTraceStats(text: string): PathTraceStats {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('stats.json is not an object');
  const number = (key: string): number => {
    const field = value[key];
    if (typeof field !== 'number' || !Number.isFinite(field)) throw new Error(`stats.json ${key} is not a finite number`);
    return field;
  };
  const { device, deterministic, denoised, stoppedBy, fallbackReason } = value;
  if (typeof device !== 'string' || typeof deterministic !== 'boolean' || typeof denoised !== 'boolean')
    throw new Error('stats.json lacks device / deterministic / denoised');
  if (typeof stoppedBy !== 'string' || !STOPS.has(stoppedBy)) throw new Error('stats.json stoppedBy is not samples | noise | time');
  return {
    samples: number('samples'),
    seed: number('seed'),
    device,
    deterministic,
    elapsedMs: number('elapsedMs'),
    noise: number('noise'),
    denoised,
    triangles: number('triangles'),
    instances: number('instances'),
    stoppedBy: stoppedBy as PathTraceStats['stoppedBy'],
    ...(typeof fallbackReason === 'string' ? { fallbackReason } : {}),
  };
}

/** A port running `binary pathtrace`. */
export function createPathTracePort(binary: string, env: NodeJS.ProcessEnv = process.env): PathTracePort {
  return {
    render(scene): PathTraceOutcome {
      try {
        return withJobFolderSync(
          pathTraceJobFiles(scene),
          (folder) => {
            const timeout = scene.job.maxSeconds * 1000 + PROCESS_MARGIN_MS;
            const run = runComputeSync(binary, ['pathtrace', folder], folder, timeout, env, MAX_EVENT_BYTES);
            if (!run.ok) return failure(run.code ?? 'NATIVE_PROTOCOL', run.message ?? 'llull-compute pathtrace failed');
            const stats = parsePathTraceStats(readOutputSync(folder, run, 'stats.json').toString('utf8'));
            const read = (name: string, wanted: boolean): Uint8Array =>
              wanted && existsSync(path.join(folder, name)) ? new Uint8Array(readOutputSync(folder, run, name)) : new Uint8Array(0);
            const png = read('image.png', scene.job.png);
            if (scene.job.png && png.length === 0) return failure('NATIVE_PROTOCOL', 'llull-compute pathtrace wrote no image.png');
            const version = `llull-compute ${computeVersionSync(binary)}`;
            return { ok: true, image: { png, exr: read('beauty.exr', scene.job.exr), stats, warnings: run.warnings, version } };
          },
          env,
        );
      } catch (error) {
        return failure('NATIVE_PROTOCOL', errorMessage(error));
      }
    },
  };
}

/** Installs the native path tracer as the process `ctx.pathTrace` when `llull-compute` exists; returns whether it did. */
export function installPathTracePort(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = nativeBinaryPath('llull-compute', env);
  setPathTracePort(binary === null ? null : createPathTracePort(binary, env));
  return binary !== null;
}
