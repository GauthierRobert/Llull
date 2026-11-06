/**
 * render_animation (PHY-22 MOV-M1): a motion source (physics simulation, joint / parameter sweep, animation clips) turned into a time-exact frame
 * sequence through ONE fixed camera, with overlays drawn as raster primitives, a timeline of the numbers behind every frame and an optional contact
 * sheet. Frames and APNG are built here (the reference raster: digests); gif / mp4 go through the host encoder `ctx.media` (MOV-M2).
 */

import { sha256Hex } from '../../lib/sha256';
import { textToBase64, uint8ArrayToBase64 } from '../../lib/base64';
import { clamp } from '../../lib/clamp';
import { round6 } from '../../lib/compactNumber';
import { encodeApng } from '../../lib/apng';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { report } from '../noop';
import { hexRgb } from './frames';
import { nativeRun, REFERENCE_RENDERER_VERSION } from './rendererProvenance';
import { surfaceShadingOf } from './surfaceShading';
import type { MediaEncoder } from '../../model/media';
import type { ViewName } from './camera';
import { encodeVideo } from './animation/encodeVideo';
import { analyseMotion } from './animation/analysis';
import { framedCamera } from './animation/framing';
import { renderAllFrames } from './animation/frameLoop';
import { overlayFont } from './animation/overlayText';
import { animationRejection } from './animation/refusals';
import { buildSheet, cellSize, sheetFrames } from './animation/sheet';
import { clipSource } from './animation/clipSource';
import { simulationSource } from './animation/simulationSource';
import { sweepSource } from './animation/sweepSource';
import { frameCountOf } from './animation/timeline';
import type { AnimationWarning, MotionFrames, OverlayIds, SourceRefusal } from './animation/types';

const DEFAULT_FPS = 30;
const DEFAULT_ACCENT = '#ff9f1c';
const DEFAULT_BACKGROUND = '#1a1a2e';
const MAX_FRAMES = 1800;
const MAX_GIF_FPS = 50;
/** Named guard: frames × width × height above this is refused for frames / apng (MOV_RENDER_BUDGET). */
const MAX_TOTAL_PIXELS = 100_000_000;

const hexOf = (rgb: readonly number[]): string => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('simulation').describe('Source: run the rigid-body physics (simulate_motion) and draw it in slow or fast motion.'),
    duration: z.number().positive().max(600).describe('Simulated seconds to run (simulate_motion `duration`), at most 600.'),
    timestep: z
      .number()
      .min(1e-5)
      .max(0.01)
      .optional()
      .describe(
        "Integration step in seconds (as simulate_motion). Default: simulate_motion's own rule. Every step is recorded while the run fits 6001 samples.",
      ),
    playbackRate: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe(
        'Simulated seconds shown per video second: 0.01 plays a 0.0628 s run (one crank turn at 954 rpm) as 6.3 s of video. Default 1. Frame k shows t = k · playbackRate / fps.',
      ),
  }),
  z.object({
    kind: z.literal('sweep').describe('Source: drive one kinematic joint or document parameter from start to end.'),
    mode: z
      .enum(['joint', 'parameter'])
      .describe('"joint": drive a kinematic joint (add_joint); "parameter": drive a document parameter (set_parameter).'),
    target: z.string().describe('The joint id (mode joint) or parameter name (mode parameter) to drive.'),
    start: z
      .number()
      .describe('First value: radians for a revolute joint, document units for a prismatic joint, the parameter unit for a parameter.'),
    end: z.number().describe('Last value, same unit as start. Must differ from start.'),
    duration: z
      .number()
      .positive()
      .max(600)
      .describe('Video seconds the sweep lasts (playbackRate is 1); frames = floor(duration · fps) + 1.'),
    pingPong: z.boolean().optional().describe('true: go from start to end and back to start over the duration (default false).'),
  }),
  z.object({
    kind: z.literal('clips').describe('Source: the document animation clips (animate), evaluated as the viewport plays them.'),
    duration: z
      .number()
      .positive()
      .max(600)
      .describe('Video seconds of the animation clips to render (animate, trigger auto; click clips are skipped).'),
  }),
]);

/**
 * @affects nothing — read-only; data { frames, fps, videoDurationS, sourceDurationS, playbackRate, width, height, format, camera, files[{ fileName, base64 }], timeline[{ frame, tS, sample?, readouts }], moving, traces?{ id: { path (all samples, 6 decimals), at (per frame, exact) } }, renderer, rendererVersion?, frameSha256?, fileSha256?, sheet?, sampleIntervalS?, warnings[{ code, message }] }
 * @invariant frames = floor(sourceDuration · fps / playbackRate + 1e-9) + 1; timeline[k].tS = k · playbackRate / fps; pose, readouts and trace dot of frame k come from the same source state; the camera is one value for all frames
 * @invariant the input document is deep-equal before and after; no FeatureStep is appended; reference frames are byte-deterministic per rendererVersion (frameSha256, APNG fileSha256)
 * @failure no motion -> MOV_NO_MOTION; unknown id -> MOV_UNKNOWN_ID; frames > maxFrames -> MOV_FRAME_BUDGET; frames × pixels > 1e8 (frames / apng) -> MOV_RENDER_BUDGET; bad camera -> MOV_CAMERA_INVALID; bad colour -> MOV_RENDER_INVALID
 * @failure gif / mp4 without ctx.media, or renderer native without ctx.raster -> NATIVE_TOOL_MISSING; simulation refused -> MOV_SOURCE_FAILED; APNG writer or video encoder failure -> MOV_ENCODE_FAILED
 * @invariant an mp4 has even sides (odd width / height rounded down by 1, MOV_SIZE_ROUNDED); a video fileSha256 is set only for the reference renderer and a deterministic encoder
 */
export const renderAnimation = defineCommand({
  name: 'render_animation',
  annotations: { readOnly: true },
  description:
    'RENDER A MOVING MECHANISM as a time-exact frame sequence, a timeline of the numbers behind each frame and a contact sheet. Sources: ' +
    '"simulation" (runs simulate_motion ONCE, then draws each frame at its exact instant t = k · playbackRate / fps by interpolating the recorded poses; use ' +
    'playbackRate < 1 for slow motion, e.g. 0.01 shows a 0.06 s crank turn as 6 s), "sweep" (drives a joint or parameter from start to end, optionally and back, with the poses of motion_study) ' +
    'or "clips" (the document\'s animate clips, evaluated exactly as the viewport plays them). The camera is fixed: framed once on every frame\'s bounds so nothing leaves the picture. ' +
    'Overlays are drawn into the picture: `time` label, `trace` (centre-of-mass path of named bodies with a dot at the current position), `readouts` (joint values, body positions, parameters or clip values as "name = value unit"; the same numbers are in data.timeline[k].readouts), data.traces[id] = { path, at[k] } gives the traced positions, `highlight: "moving"` (moving parts in the accent colour). ' +
    'REVIEW LOOP: first render format "frames" with `sheet` {every: n} and look at sheet.png (one image of every n-th frame, labelled #k t = … s) to check camera, overlays and motion; then render the format you want to keep. ' +
    'Formats: "frames" (PNG files frame-0001.png …), "apng" (animation.apng, loops forever), "gif" / "mp4" (animation.gif / animation.mp4 through the native video encoder, AV1 in MP4; a host without it refuses with NATIVE_TOOL_MISSING: use "apng"; `quality` draft | standard | high applies to mp4 only; a gif is made at most 50 fps, MOV_GIF_FPS_CLAMPED). The default is "mp4", so set `format` explicitly in a host without the encoder. ' +
    'Always in data.files: timeline.json (and sheet.png with `sheet`). The reference renderer (default) gives data.frameSha256[] (and fileSha256 for apng), stable per rendererVersion; renderer "native" draws on the GPU through llull-compute (no digests). ' +
    'Budgets (stable codes): MOV_FRAME_BUDGET (more than maxFrames, at most 1800), MOV_RENDER_BUDGET (frames × width × height over 1e8 for frames / apng). Other refusals: MOV_ENCODE_FAILED (the encoder failed; nothing is returned), MOV_NO_MOTION, MOV_UNKNOWN_ID, MOV_SOURCE_FAILED, MOV_CAMERA_INVALID, MOV_RENDER_INVALID, NATIVE_TOOL_MISSING. ' +
    'Warnings in data.warnings: MOV_SAMPLES_SPARSE (the simulation samples are further apart than a frame; poses are interpolated), MOV_SIZE_ROUNDED (odd mp4 size rounded down to even), MOV_GIF_FPS_CLAMPED (gif above 50 fps made at 50), MOV_CLICK_CLIPS_SKIPPED, MOV_LOOP_OPEN, MOV_OVERLAY_TEXT_SKIPPED (no bundled font: labels not drawn). ' +
    'Read-only: the document is never changed. CLI: `--save dir/` writes all files, `--save out.mp4` (or .gif, .apng) writes that one file and out.timeline.json.',
  params: z.object({
    source: sourceSchema.describe('What moves: a simulation, a joint / parameter sweep or the animation clips.'),
    fps: z.number().int().min(1).max(60).optional().describe('Video frames per second, 1..60. Default 30.'),
    width: z.number().optional().describe('Frame width in pixels, clamped to [64, 1920]. Default 1280.'),
    height: z.number().optional().describe('Frame height in pixels, clamped to [64, 1080]. Default 720.'),
    camera: z
      .object({
        view: z
          .enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'])
          .optional()
          .describe(
            'Named view; planar mechanisms read best face-on ("front" for a crank in the XZ plane, "top" for the XY plane). Default "iso".',
          ),
        direction: vec3('Viewing direction [x, y, z] from the scene toward the camera (Z-up). Give this OR view, not both.').optional(),
      })
      .optional()
      .describe('The one fixed camera, framed on all frames.'),
    overlays: z
      .object({
        time: z.boolean().optional().describe('Draw "t = … s" (simulated time) top left. Default false.'),
        trace: z
          .array(z.string())
          .max(4)
          .optional()
          .describe(
            'Up to 4 ids whose position is traced: rigid body ids (simulation: centre of mass over all samples) or entity ids (sweep / clips: the entity position over the frames).',
          ),
        readouts: z
          .array(z.string())
          .max(8)
          .optional()
          .describe(
            'Up to 8 quantities shown as "name = value unit" bottom left and listed in data.timeline[k].readouts: simulation: joint ids (deg or document units) and rigid body ids (their centre of mass as id.x, id.y, id.z); sweep: joint ids and parameter names; clips: clip ids (animate).',
          ),
        highlight: z
          .enum(['moving', 'none'])
          .optional()
          .describe('"moving": entities whose pose changes during the run are drawn in the accent colour; "none" (default).'),
        accent: z.string().optional().describe('Accent colour #rgb or #rrggbb for highlight. Default #ff9f1c.'),
      })
      .optional()
      .describe('Pictures drawn into every frame.'),
    format: z
      .enum(['frames', 'apng', 'gif', 'mp4'])
      .optional()
      .describe(
        '"frames", "apng", "gif" or "mp4" (default). gif / mp4 need the native encoder and are refused without it (NATIVE_TOOL_MISSING): retry with format "apng".',
      ),
    quality: z
      .enum(['draft', 'standard', 'high'])
      .optional()
      .describe(
        'Encoder effort for format "mp4" only (gif, frames and apng ignore it): "draft" = a smaller, softer file in the same encode time as "standard" (default); "high" = sharper, about twice the encode time.',
      ),
    sheet: z
      .object({ every: z.number().int().min(1).describe('Every n-th frame becomes a cell (the last frame is always added).') })
      .optional()
      .describe('Also produce sheet.png: a labelled contact sheet of the frames (cells at most 320 px wide, at most 6 columns).'),
    maxFrames: z
      .number()
      .int()
      .min(1)
      .max(1800)
      .optional()
      .describe('Refuse (MOV_FRAME_BUDGET) when the run needs more frames than this. Default and maximum 1800.'),
    background: z.string().optional().describe('Frame background #rgb or #rrggbb. Default #1a1a2e.'),
    renderer: z
      .enum(['reference', 'native'])
      .optional()
      .describe('"reference" (default, deterministic, digests) or "native" (GPU frames through llull-compute, no digests).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (
      code: string,
      message: string,
      ids: readonly string[] = [],
      paths: readonly string[] = [],
      warnings: readonly AnimationWarning[] = [],
    ): CommandResult =>
      animationRejection(doc, 'render_animation', code, message, ids, paths, warnings.length === 0 ? undefined : { warnings });
    const { source } = params;
    const format = params.format ?? 'mp4';
    // GIF delays are whole centiseconds and viewers clamp 1 cs to 10 cs: above 50 fps the whole animation is made at 50 fps
    const askedFps = params.fps ?? DEFAULT_FPS;
    const fps = format === 'gif' ? Math.min(askedFps, MAX_GIF_FPS) : askedFps;
    const videoFormat = format === 'gif' || format === 'mp4' ? format : null;
    const askedWidth = clamp(Math.round(params.width ?? 1280), 64, 1920);
    const askedHeight = clamp(Math.round(params.height ?? 720), 64, 1080);
    // 4:2:0 needs even sides: an odd mp4 size is rounded down by one
    const width = format === 'mp4' ? askedWidth - (askedWidth % 2) : askedWidth;
    const height = format === 'mp4' ? askedHeight - (askedHeight % 2) : askedHeight;
    const camera = params.camera ?? {};
    if (camera.view !== undefined && camera.direction !== undefined)
      return fail('MOV_CAMERA_INVALID', 'camera gives both view and direction', [], ['camera']);
    if (camera.direction !== undefined && !(camera.direction.every(Number.isFinite) && Math.hypot(...camera.direction) > 1e-9))
      return fail('MOV_CAMERA_INVALID', 'camera.direction must be a finite, non-zero [x, y, z]', [], ['camera.direction']);
    const background = hexRgb(params.background ?? DEFAULT_BACKGROUND);
    if (background === null)
      return fail('MOV_RENDER_INVALID', `background "${params.background ?? ''}" is not #rgb or #rrggbb`, [], ['background']);
    const accent = hexRgb(params.overlays?.accent ?? DEFAULT_ACCENT);
    if (accent === null)
      return fail('MOV_RENDER_INVALID', `accent "${params.overlays?.accent ?? ''}" is not #rgb or #rrggbb`, [], ['overlays.accent']);

    const playbackRate = source.kind === 'simulation' ? (source.playbackRate ?? 1) : 1;
    const frames = frameCountOf(source.duration, fps, playbackRate);
    const maxFrames = params.maxFrames ?? MAX_FRAMES;
    if (frames > maxFrames)
      return fail(
        'MOV_FRAME_BUDGET',
        `${frames} frames (${source.duration} s at ${fps} fps, playbackRate ${playbackRate}) exceed maxFrames ${maxFrames}`,
        [],
        ['maxFrames'],
      );
    if ((format === 'frames' || format === 'apng') && frames * width * height > MAX_TOTAL_PIXELS)
      return fail(
        'MOV_RENDER_BUDGET',
        `${frames} frames of ${width}×${height} are ${frames * width * height} pixels (limit ${MAX_TOTAL_PIXELS})`,
        [],
        ['width'],
      );
    const media = format === 'gif' || format === 'mp4' ? (ctx?.media ?? null) : undefined;
    if (media === null)
      return fail(
        'NATIVE_TOOL_MISSING',
        `format "${format}" needs the native video encoder (llull-compute media), which this host does not provide`,
        [],
        ['format'],
      );
    const native = params.renderer === 'native' ? (ctx?.raster ?? null) : undefined;
    if (native === null)
      return fail(
        'NATIVE_TOOL_MISSING',
        'renderer "native" needs the native raster (llull-compute), which this host does not provide',
        [],
        ['renderer'],
      );

    const ids: OverlayIds = { trace: params.overlays?.trace ?? [], readouts: params.overlays?.readouts ?? [] };
    const made: MotionFrames | SourceRefusal =
      source.kind === 'simulation'
        ? simulationSource(doc, { duration: source.duration, timestep: source.timestep, playbackRate, fps, frames }, ids, ctx)
        : source.kind === 'sweep'
          ? sweepSource(
              doc,
              {
                mode: source.mode,
                target: source.target,
                start: source.start,
                end: source.end,
                pingPong: source.pingPong === true,
                fps,
                frames,
              },
              ids,
            )
          : clipSource(doc, { fps, frames }, ids);
    if ('refused' in made) return fail(made.refused.code, made.refused.message, made.refused.ids, [], made.refused.warnings);
    const motion = made;

    const analysis = analyseMotion(motion, frames);
    if (analysis.bounds === null || analysis.moving.length === 0)
      return fail(
        'MOV_NO_MOTION',
        `nothing moves during the ${source.kind} run (every entity keeps its pose in all ${frames} frames)`,
        [],
        [],
        motion.warnings,
      );
    const view: ViewName = camera.direction === undefined ? (camera.view ?? 'iso') : 'custom';
    const fixed = framedCamera(view, camera.direction, analysis.bounds, width, height);
    const colorOverrides =
      params.overlays?.highlight === 'moving' ? Object.fromEntries(analysis.moving.map((id) => [id, hexOf(accent)])) : undefined;
    const font = overlayFont(ctx);
    const wantsText = params.overlays?.time === true || ids.readouts.length > 0 || ids.trace.length > 0 || params.sheet !== undefined;
    const warnings: AnimationWarning[] = [...motion.warnings];
    if (width !== askedWidth || height !== askedHeight)
      warnings.push({
        code: 'MOV_SIZE_ROUNDED',
        message: `mp4 needs even sides: ${askedWidth}×${askedHeight} rendered as ${width}×${height}`,
      });
    if (fps !== askedFps)
      warnings.push({
        code: 'MOV_GIF_FPS_CLAMPED',
        message: `a GIF cannot show delays under 2 cs (viewers clamp 1 cs to 10 cs): ${askedFps} fps rendered as ${fps} fps`,
      });
    if (wantsText && font === null)
      warnings.push({
        code: 'MOV_OVERLAY_TEXT_SKIPPED',
        message: 'no bundled font in this host (ctx.fonts): time labels, readout text, trace names and sheet labels are not drawn',
      });
    const run = native === undefined ? null : nativeRun(native, 'gpu');
    const picked = params.sheet === undefined ? [] : sheetFrames(frames, params.sheet.every);
    const drawn = renderAllFrames({
      motion,
      frames,
      width,
      height,
      camera: fixed,
      bounds: analysis.bounds,
      background,
      pixels: run?.pixels,
      shading: surfaceShadingOf(doc, ctx),
      colorOverrides,
      font,
      time: params.overlays?.time === true,
      sheetFrames: new Set(picked),
    });
    if (run !== null) {
      const outcome = run.result();
      if ('code' in outcome) return fail(outcome.code, outcome.message, [], ['renderer']);
    }
    const files: { fileName: string; base64: string }[] = [];
    let fileSha256: string | undefined;
    let encoder: MediaEncoder | undefined;
    if (format === 'apng') {
      const apng = encodeApng(drawn.pngs, fps);
      if (apng === null) return fail('MOV_ENCODE_FAILED', 'the APNG writer rejected the frames');
      files.push({ fileName: 'animation.apng', base64: uint8ArrayToBase64(apng) });
      if (run === null) fileSha256 = sha256Hex(apng);
    } else if (media !== undefined && videoFormat !== null) {
      const video = encodeVideo(
        media,
        { format: videoFormat, width, height, fps, quality: params.quality ?? 'standard', frames },
        drawn.pngs,
      );
      if (!video.ok) return fail(video.code, video.message, [], ['format'], warnings);
      files.push({ fileName: `animation.${format}`, base64: uint8ArrayToBase64(video.bytes) });
      encoder = video.encoder;
      if (run === null && video.encoder.deterministic) fileSha256 = sha256Hex(video.bytes);
    } else {
      drawn.pngs.forEach((png, k) =>
        files.push({ fileName: `frame-${String(k + 1).padStart(4, '0')}.png`, base64: uint8ArrayToBase64(png) }),
      );
    }
    files.push({
      fileName: 'timeline.json',
      base64: textToBase64(JSON.stringify({ fps, playbackRate, frames, timeline: motion.timeline })),
    });
    let sheetData: { frames: number[]; columns: number; width: number; height: number } | undefined;
    if (params.sheet !== undefined) {
      const sheet = buildSheet(drawn.cells, cellSize(width, height), font);
      files.push({ fileName: 'sheet.png', base64: uint8ArrayToBase64(sheet.png) });
      sheetData = { frames: picked, columns: sheet.columns, width: sheet.width, height: sheet.height };
    }
    const base = {
      frames,
      fps,
      videoDurationS: frames / fps,
      sourceDurationS: source.duration,
      playbackRate,
      width,
      height,
      format,
      camera: fixed,
      files,
      timeline: motion.timeline,
      moving: analysis.moving,
      ...(motion.traces.length === 0
        ? {}
        : {
            traces: Object.fromEntries(
              motion.traces.map((trace) => [trace.id, { path: trace.path.map((p) => p.map(round6)), at: trace.at }]),
            ),
          }),
      ...(sheetData === undefined ? {} : { sheet: sheetData }),
      ...(encoder === undefined ? {} : { encoder }),
      ...(motion.sampleIntervalS === undefined ? {} : { sampleIntervalS: motion.sampleIntervalS }),
      warnings,
    };
    const summary =
      `render_animation: ${frames} frame(s) at ${fps} fps (${+(frames / fps).toFixed(4)} s of video, ${source.kind} ${source.duration} s${playbackRate === 1 ? '' : ` at playbackRate ${playbackRate}`}), ${width}×${height}, ` +
      `${view} view, format ${format}; ${analysis.moving.length} moving entit${analysis.moving.length === 1 ? 'y' : 'ies'}` +
      `${warnings.length === 0 ? '' : `; warnings: ${warnings.map((w) => w.code).join(', ')}`}. Save the files with --save <dir>/ (or --save out.${format === 'frames' ? 'png' : format}).`;
    if (run === null)
      return report(doc, summary, {
        ...base,
        renderer: 'reference',
        rendererVersion: REFERENCE_RENDERER_VERSION,
        frameSha256: drawn.pngs.map((png) => sha256Hex(png)),
        ...(fileSha256 === undefined ? {} : { fileSha256 }),
      });
    return report(doc, `${summary} (native pictures, no digests)`, { ...base, ...run.result() });
  },
});
