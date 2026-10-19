/**
 * `ctx.raster` host transport (plant 09 VIS-M9, RS1 RS-5): a `RasterPort` that runs `llull-compute raster` on a render scene
 * (`job.json` "kind": "scene" + flat f64 buffers -> `rgba.bin`). Commands are synchronous, so the job runs with spawnSync: the caller
 * blocks for one frame (an offscreen GPU frame is tens of milliseconds plus the process start). Installed by the CLI and the backend
 * only when the binary exists; without it `renderer: 'native'` refuses with NATIVE_TOOL_MISSING (llull stays fully usable).
 * Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_NATIVE_KEEP=1 (keep job folders).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RasterImage, RasterOutcome, RasterPort, RasterScene } from '@core/model/raster';
import { setRasterPort } from '@core/commands/rasterPort';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';
import { f64Bytes } from './computeJob';
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

interface Events {
  readonly done?: { readonly path: string; readonly sha256: string }[];
  readonly error?: { readonly code: string; readonly message: string };
  readonly warnings: { readonly code: string; readonly message: string }[];
}

/** The NDJSON events of a finished run (unparseable lines are ignored; a missing final event is a protocol failure upstream). */
function eventsOf(stdout: string): Events {
  const warnings: { code: string; message: string }[] = [];
  let done: { path: string; sha256: string }[] | undefined;
  let error: { code: string; message: string } | undefined;
  for (const line of stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event['type'] === 'warning') warnings.push({ code: String(event['code']), message: String(event['message']) });
    if (event['type'] === 'error') error = { code: String(event['code']), message: String(event['message']) };
    if (event['type'] === 'done' && Array.isArray(event['outputs']))
      done = event['outputs'].filter(isRecord).map((output) => ({ path: String(output['path']), sha256: String(output['sha256']) }));
  }
  return { warnings, ...(done !== undefined ? { done } : {}), ...(error !== undefined ? { error } : {}) };
}

function provenance(events: Events, engine: 'gpu' | 'cpu', version: string): Omit<RasterImage, 'rgba'> {
  const gpu = events.warnings.find((warning) => warning.code === 'NATIVE_RASTER_GPU');
  if (gpu !== undefined)
    return { engine: 'native-gpu', device: /GPU \((.*)\): a picture/.exec(gpu.message)?.[1] ?? 'gpu', deterministic: false, version };
  const fallback = events.warnings.find((warning) => warning.code === 'NATIVE_RASTER_CPU_FALLBACK');
  const reason = engine === 'gpu' ? { reason: fallback?.message ?? 'the GPU was not used' } : {};
  return { engine: 'native-cpu', device: 'cpu', deterministic: true, version, ...reason };
}

/** A port running `binary`; `version` is read once from `--version`. */
export function createNativeRasterPort(binary: string, env: NodeJS.ProcessEnv = process.env): RasterPort {
  let version: string | null = null;
  const versionOf = (): string => {
    if (version === null) {
      const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      version = /llull-compute\s+\S+/.exec(probe.stdout ?? '')?.[0] ?? 'llull-compute unknown';
    }
    return version;
  };
  return {
    render(scene, engine): RasterOutcome {
      const folder = mkdtempSync(path.join(tmpdir(), 'llull-raster-'));
      try {
        for (const [name, content] of Object.entries(jobFiles(scene, engine))) writeFileSync(path.join(folder, name), content);
        const run = spawnSync(binary, ['raster', folder], {
          cwd: folder,
          env,
          encoding: 'utf8',
          timeout: FRAME_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        });
        if (run.error !== undefined) {
          const timedOut = (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
          return timedOut
            ? failure('NATIVE_TIMEOUT', `llull-compute raster timed out after ${FRAME_TIMEOUT_MS} ms`)
            : failure('NATIVE_TOOL_MISSING', `cannot run ${binary}: ${run.error.message}`);
        }
        const events = eventsOf(run.stdout ?? '');
        if (events.error !== undefined) return failure(events.error.code, events.error.message);
        const output = events.done?.find((entry) => entry.path === 'rgba.bin');
        if (run.status !== 0 || output === undefined)
          return failure('NATIVE_PROTOCOL', `llull-compute raster exited with ${String(run.status)} without an rgba.bin output`);
        const rgba = readFileSync(path.join(folder, 'rgba.bin'));
        if (createHash('sha256').update(rgba).digest('hex') !== output.sha256)
          return failure('NATIVE_PROTOCOL', 'rgba.bin does not match the hash llull-compute reported');
        if (rgba.length !== scene.width * scene.height * 4)
          return failure('NATIVE_PROTOCOL', `rgba.bin has ${rgba.length} bytes for a ${scene.width} x ${scene.height} image`);
        return { ok: true, image: { rgba: new Uint8Array(rgba), ...provenance(events, engine, versionOf()) } };
      } catch (error) {
        return failure('NATIVE_PROTOCOL', errorMessage(error));
      } finally {
        if (env['LLULL_NATIVE_KEEP'] !== '1') rmSync(folder, { recursive: true, force: true });
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
