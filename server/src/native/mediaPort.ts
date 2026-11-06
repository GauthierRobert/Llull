/**
 * `ctx.media` host transport (PHY-22 MOV-M2, TR-MOV-12): a `MediaPort` that encodes the PNG frames of `render_animation` to a GIF or an AV1 MP4
 * with `llull-compute media`. One session = one job folder: `add` writes `frame-%05d.png` (memory stays one frame), `finish` writes `job.json`
 * and runs the job through `runComputeSync` (tree kill on timeout; commands are synchronous, the host blocks for the encode), reads `out.mp4` /
 * `out.gif` and `report.json` (encoder name, version, determinism), then removes the folder. `abort` removes it too. Folder contract:
 * `solver/crates/llull-media/src/job.rs`. The job reports one `progress` event per frame; the synchronous runner parses them with the rest of the
 * output, so a caller sees them only when the job ends (a live relay needs the async runner, which a synchronous command cannot await).
 * Installed by the CLI and the backend only when the binary exists; without it gif / mp4 refuse with NATIVE_TOOL_MISSING (llull stays fully usable).
 * Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_NATIVE_KEEP=1 (keep job folders).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MediaEncoder, MediaFailure, MediaPort, MediaSession, MediaSpec } from '@core/model/media';
import { setMediaPort } from '@core/commands/mediaPort';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { readOutputSync, runComputeSync } from './computeJob';
import { nativeBinaryPath } from './nativeBinary';

/** Named guards: process start allowance + a generous per-frame share (the encode runs at 4..15 frames per second, spec §13.6). */
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_FRAME_MS = 500;
/** One progress line per frame (~100 bytes) plus the events around them. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

const failure = (code: string, message: string): MediaFailure => ({ ok: false, code, message });

/** Tuning of a port: tests shrink the wait. */
export interface MediaPortOptions {
  /** Wait for the whole job in ms. Default: 30 s + 0.5 s per frame. */
  readonly timeoutMs?: number;
}

function encoderOf(report: Buffer, fallback: string): MediaEncoder {
  const parsed: unknown = JSON.parse(report.toString('utf8'));
  const encoder = isRecord(parsed) ? parsed['encoder'] : undefined;
  if (!isRecord(encoder) || typeof encoder['name'] !== 'string' || typeof encoder['version'] !== 'string')
    return { name: fallback, version: 'unknown', deterministic: false };
  return { name: encoder['name'], version: encoder['version'], deterministic: encoder['deterministic'] === true };
}

function session(binary: string, env: NodeJS.ProcessEnv, spec: MediaSpec, options: MediaPortOptions): MediaSession | MediaFailure {
  let folder: string;
  try {
    folder = mkdtempSync(path.join(tmpdir(), 'llull-compute-'));
  } catch (error) {
    return failure('NATIVE_PROTOCOL', `cannot create the job folder: ${errorMessage(error)}`);
  }
  let added = 0;
  let closed = false;
  const remove = (): void => {
    closed = true;
    if (env['LLULL_NATIVE_KEEP'] !== '1') rmSync(folder, { recursive: true, force: true });
  };
  return {
    add(png) {
      if (closed) return failure('NATIVE_PROTOCOL', 'the media session is closed');
      if (added >= spec.frames) return failure('NATIVE_JOB_INPUT', `more than the ${spec.frames} frames announced`);
      try {
        writeFileSync(path.join(folder, `frame-${String(added).padStart(5, '0')}.png`), png);
      } catch (error) {
        remove();
        return failure('NATIVE_PROTOCOL', `cannot write frame ${added + 1}: ${errorMessage(error)}`);
      }
      added += 1;
      return null;
    },
    finish() {
      if (closed) return failure('NATIVE_PROTOCOL', 'the media session is closed');
      try {
        if (added !== spec.frames) return failure('NATIVE_JOB_INPUT', `${added} frames were added, ${spec.frames} announced`);
        const { format, width, height, fps, quality, frames } = spec;
        writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ version: 1, format, width, height, fps, quality, frames }));
        const timeout = options.timeoutMs ?? TIMEOUT_BASE_MS + frames * TIMEOUT_PER_FRAME_MS;
        const run = runComputeSync(binary, ['media', folder], folder, timeout, env, MAX_STDOUT_BYTES);
        if (!run.ok) return failure(run.code ?? 'NATIVE_PROTOCOL', run.message ?? 'llull-compute media failed');
        const bytes = readOutputSync(folder, run, `out.${format}`);
        const encoder = encoderOf(readOutputSync(folder, run, 'report.json'), 'llull-compute media');
        return { ok: true, bytes: new Uint8Array(bytes), encoder };
      } catch (error) {
        return failure('NATIVE_PROTOCOL', errorMessage(error));
      } finally {
        remove();
      }
    },
    abort: remove,
  };
}

/** A port running `binary`. */
export function createNativeMediaPort(binary: string, env: NodeJS.ProcessEnv = process.env, options: MediaPortOptions = {}): MediaPort {
  return { open: (spec) => session(binary, env, spec, options) };
}

/** Installs the native encoder as the process `ctx.media` when `llull-compute` exists; returns whether it did. */
export function installMediaPort(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = nativeBinaryPath('llull-compute', env);
  setMediaPort(binary === null ? null : createNativeMediaPort(binary, env));
  return binary !== null;
}
