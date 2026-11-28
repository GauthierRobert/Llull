/**
 * Result of `render_realistic`: the PNG and EXR the native job wrote, its provenance (samples, seed, device, deterministic, stop reason)
 * and a summary naming how the picture was made. An EXR over EXR_INLINE_MAX_BYTES goes to the host's export file sink (data.file) when
 * there is one, else it is left out with a warning (the PNG always returns).
 * @pure (the file sink write is the host's idempotent artifact output, as export_3mf toFile)
 */

import type { CadDocument } from '../../../model/types';
import type { PathTraceImage, PathTraceScene } from '../../../model/pathTrace';
import type { CommandResult, ExportFilePort } from '../../types';
import { report } from '../../noop';
import { uint8ArrayToBase64 } from '../../../lib/base64';

/** Largest EXR returned inline as base64 (a 4096 x 4096 RGBA half image is 128 MiB). */
export const EXR_INLINE_MAX_BYTES = 160 * 1024 * 1024;

interface Notes {
  readonly cameraId: string | undefined;
  readonly lighting: string;
  readonly environment: string;
}

interface Warning {
  readonly code: string;
  readonly message: string;
}

type ExrPayload = { readonly inline: string } | { readonly file: { readonly path: string; readonly bytes: number } } | null;

function exrPayload(exr: Uint8Array, sink: ExportFilePort | null, warnings: Warning[]): ExrPayload {
  if (exr.length === 0) return null;
  if (exr.length <= EXR_INLINE_MAX_BYTES) return { inline: uint8ArrayToBase64(exr) };
  let writer: ReturnType<ExportFilePort['open']> = null;
  try {
    writer = sink?.open('render.exr') ?? null;
    if (writer !== null) {
      writer.write(exr);
      return { file: { path: writer.close().path, bytes: exr.length } };
    }
  } catch (error) {
    writer?.abort();
    warnings.push({ code: 'RENDER_EXR_NOT_RETURNED', message: `writing render.exr failed: ${String(error)}` });
    return null;
  }
  warnings.push({
    code: 'RENDER_EXR_NOT_RETURNED',
    message: `the EXR has ${exr.length} bytes (over ${EXR_INLINE_MAX_BYTES} inline) and this host has no export file sink: run through the llull CLI or the desktop app, or render smaller`,
  });
  return null;
}

export function realisticResult(
  doc: CadDocument,
  scene: PathTraceScene,
  image: PathTraceImage,
  notes: Notes,
  sink: ExportFilePort | null = null,
): CommandResult {
  const { job } = scene;
  const { stats } = image;
  const warnings: Warning[] = [...image.warnings];
  const png = uint8ArrayToBase64(image.png);
  const exr = exrPayload(image.exr, sink, warnings);
  const files = [
    { name: 'render.png', base64: png },
    ...(exr !== null && 'inline' in exr ? [{ name: 'render.exr', base64: exr.inline }] : []),
  ];
  const stop =
    stats.stoppedBy === 'time'
      ? `stopped by maxSeconds ${job.maxSeconds}`
      : stats.stoppedBy === 'noise'
        ? `stopped at noise ${job.targetNoise}`
        : 'all samples';
  const device = stats.fallbackReason === undefined ? stats.device : `${stats.device} (${stats.fallbackReason})`;
  const summary =
    `Path-traced ${job.width}x${job.height}: ${stats.samples.toFixed(1)} samples per pixel (${stop}), ${job.maxBounces} bounces, seed ${stats.seed}, ` +
    `${stats.triangles} triangles in ${stats.instances} placed parts, ${job.materials.length} materials, ${job.textures.length} textures; ` +
    `${notes.lighting}; environment: ${notes.environment}; ${notes.cameraId === undefined ? `${job.camera.projection} view` : `camera ${notes.cameraId}`}; ` +
    `${device}, ${stats.deterministic ? 'deterministic' : 'not deterministic'}, noise ${stats.noise.toFixed(4)}${stats.denoised ? ', denoised' : ''}, ` +
    `${Math.round(stats.elapsedMs)} ms. An illustration, not a measurement.`;
  return report(doc, summary, {
    illustration: true,
    files,
    ...(exr !== null && 'file' in exr ? { file: exr.file, fileName: 'render.exr' } : {}),
    width: job.width,
    height: job.height,
    samples: stats.samples,
    samplesRequested: job.samples,
    seed: stats.seed,
    device: stats.device,
    ...(stats.fallbackReason !== undefined ? { fallbackReason: stats.fallbackReason } : {}),
    deterministic: stats.deterministic,
    stoppedBy: stats.stoppedBy,
    noise: stats.noise,
    denoised: stats.denoised,
    elapsedMs: stats.elapsedMs,
    triangles: stats.triangles,
    instances: stats.instances,
    maxBounces: job.maxBounces,
    exposure: job.exposure,
    ...(notes.cameraId !== undefined ? { cameraId: notes.cameraId } : {}),
    lighting: notes.lighting,
    environment: notes.environment,
    version: image.version,
    warnings,
  });
}
