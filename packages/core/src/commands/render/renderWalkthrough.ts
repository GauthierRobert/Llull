/**
 * render_walkthrough (plant 09 VIS §4, VIS-M9): the frames of a walkthrough as PNG files, the camera gliding between its viewpoints
 * (eye linear, direction / up spherical, fov or view height linear). Reference frames carry a sha256 each (deterministic per
 * rendererVersion); native frames (`renderer: 'native'`, `ctx.raster`) are pictures without digests.
 */

import type { ViewpointCamera } from '../../model/review';
import { interpolateViewpointCamera } from '../../geometry/viewpointCamera';
import { sha256Hex } from '../../lib/sha256';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { clamp } from '../../lib/clamp';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { reviewOf, reviewRejection } from '../review/reviewModel';
import { FRAME_BACKGROUND, hexRgb, renderCameraPng, sceneCenter } from './frames';
import { nativeRun, REFERENCE_RENDERER_VERSION } from './rendererProvenance';
import { rasterScenePixels } from './raster';

const MAX_FRAMES = 600;
/** Named guard: frames × width × height above this is refused (VIS_RENDER_BUDGET). */
const MAX_TOTAL_PIXELS = 100_000_000;

/** Camera at time `t` (seconds) of a walkthrough whose key k lasts `seconds[k]`. */
function cameraAt(cameras: readonly ViewpointCamera[], seconds: readonly number[], t: number): ViewpointCamera {
  let start = 0;
  for (let k = 0; k + 1 < cameras.length; k += 1) {
    const span = seconds[k] ?? 0;
    const a = cameras[k];
    const b = cameras[k + 1];
    if (a !== undefined && b !== undefined && (t <= start + span || k + 2 === cameras.length))
      return interpolateViewpointCamera(a, b, clamp((t - start) / span, 0, 1));
    start += span;
  }
  return cameras[0] as ViewpointCamera;
}

/**
 * @affects nothing — read-only; data.files are the PNG frames (`--save dir/`)
 * @invariant frames = floor(duration · fps) + 1; reference frameSha256[i] = sha256 of files[i]
 * @failure unknown walkthrough -> VIS_WALKTHROUGH_NOT_FOUND; frames > maxFrames -> VIS_WALKTHROUGH_INVALID; frames × pixels too large ->
 *   VIS_RENDER_BUDGET; bad background -> VIS_RENDER_INVALID; native without port / failed frame -> NATIVE_TOOL_MISSING / the job code
 */
export const renderWalkthrough = defineCommand({
  name: 'render_walkthrough',
  description:
    'Render a walkthrough (create_walkthrough) to PNG frames: the camera glides between the saved viewpoints (eye linear, direction ' +
    'spherical) at `fps` frames per second; frames = floor(duration × fps) + 1. Solids and sketches only (no grid / axes). data: { frames, ' +
    'fps, durationS, width, height, files: [{ fileName: "frame-0001.png", base64 }] } — save them with `--save dir/`. renderer "reference" ' +
    '(default) adds frameSha256[] (deterministic per rendererVersion); "native" draws each frame on the GPU with llull-compute (CLI / ' +
    'desktop only): GPU frames without digests, data.deterministic false. Errors: VIS_WALKTHROUGH_NOT_FOUND, VIS_WALKTHROUGH_INVALID (more ' +
    'frames than maxFrames), VIS_RENDER_BUDGET, NATIVE_TOOL_MISSING.',
  annotations: { readOnly: true },
  params: z.object({
    id: z.string().describe('Walkthrough id (wt-<n>).'),
    fps: z.number().int().optional().describe('Frames per second, 1..30. Default 10.'),
    width: z.number().optional().describe('Frame width in pixels, clamped to [64, 2000]. Default 640.'),
    height: z.number().optional().describe('Frame height in pixels, clamped to [64, 2000]. Default 360.'),
    maxFrames: z.number().int().optional().describe('Refuse when the walkthrough needs more frames than this (1..600). Default 600.'),
    background: z.string().optional().describe('Frame background "#rrggbb". Default "#1a1a2e".'),
    renderer: z.enum(['reference', 'native']).optional().describe('"reference" (default, digests) or "native" (GPU frames, no digests).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      reviewRejection(doc, 'render_walkthrough', code, message, [params.id], paths);
    const walkthrough = reviewOf(doc).walkthroughs[params.id];
    if (walkthrough === undefined) return fail('VIS_WALKTHROUGH_NOT_FOUND', `no walkthrough '${params.id}'`);
    const cameras = walkthrough.keys.map((key) => reviewOf(doc).viewpoints[key.viewpointId]?.camera);
    if (cameras.some((camera) => camera === undefined)) return fail('VIS_VIEWPOINT_NOT_FOUND', 'a key references a missing viewpoint');
    const fps = clamp(params.fps ?? 10, 1, 30);
    const width = clamp(Math.round(params.width ?? 640), 64, 2000);
    const height = clamp(Math.round(params.height ?? 360), 64, 2000);
    const maxFrames = clamp(params.maxFrames ?? MAX_FRAMES, 1, MAX_FRAMES);
    const seconds = walkthrough.keys.map((key) => key.seconds);
    const durationS = seconds.slice(0, -1).reduce((sum, s) => sum + s, 0);
    const frames = Math.floor(durationS * fps + 1e-9) + 1;
    if (frames > maxFrames)
      return fail('VIS_WALKTHROUGH_INVALID', `${frames} frames (${durationS} s at ${fps} fps) exceed maxFrames ${maxFrames}`, [
        'maxFrames',
      ]);
    if (frames * width * height > MAX_TOTAL_PIXELS)
      return fail('VIS_RENDER_BUDGET', `${frames} frames of ${width}×${height} exceed ${MAX_TOTAL_PIXELS} pixels`, ['width']);
    const background = hexRgb(params.background ?? FRAME_BACKGROUND);
    if (background === null) return fail('VIS_RENDER_INVALID', `background "${params.background ?? ''}" is not #rrggbb`, ['background']);
    const native = params.renderer === 'native' ? (ctx?.raster ?? null) : undefined;
    if (native === null) return fail('NATIVE_TOOL_MISSING', 'no native raster (llull-compute) is installed in this host', ['renderer']);
    const run = native === undefined ? null : nativeRun(native, 'gpu');
    const center = sceneCenter(doc);
    const keyCameras = cameras as ViewpointCamera[];
    const files: { fileName: string; base64: string }[] = [];
    const digests: string[] = [];
    for (let i = 0; i < frames; i += 1) {
      const camera = cameraAt(keyCameras, seconds, i / fps);
      const png = renderCameraPng(doc, camera, width, height, background, center, run?.pixels ?? rasterScenePixels);
      files.push({ fileName: `frame-${String(i + 1).padStart(4, '0')}.png`, base64: uint8ArrayToBase64(png) });
      if (run === null) digests.push(sha256Hex(png));
    }
    const base = { id: params.id, frames, fps, durationS, width, height, files };
    const summary = `Rendered walkthrough ${params.id} "${walkthrough.name}": ${frames} frame(s) at ${fps} fps, ${width}×${height}`;
    if (run === null)
      return report(doc, `${summary} (reference raster). Save the frames with --save <dir>/.`, {
        ...base,
        renderer: 'reference',
        rendererVersion: REFERENCE_RENDERER_VERSION,
        frameSha256: digests,
      });
    const outcome = run.result();
    if ('code' in outcome) return fail(outcome.code, outcome.message, ['renderer']);
    return report(doc, `${summary} (native ${outcome.engine}, ${outcome.device}; pictures, no digests).`, { ...base, ...outcome });
  },
});
