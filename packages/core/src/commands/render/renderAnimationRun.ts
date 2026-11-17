/** render_animation phases: request checks, motion source, camera + frames, encoding, report. */

import { sha256Hex } from '../../lib/sha256';
import { textToBase64, uint8ArrayToBase64 } from '../../lib/base64';
import { clamp } from '../../lib/clamp';
import { round6 } from '../../lib/compactNumber';
import { encodeApng } from '../../lib/apng';
import type { ParsedFont } from '../../lib/font/font';
import type { CadDocument } from '../../model/types';
import type { MediaEncoder } from '../../model/media';
import type { CommandResult, ExecutionContext } from '../types';
import type { z } from '../schema';
import { report } from '../noop';
import { hexRgb } from './frames';
import { nativeRun, REFERENCE_RENDERER_VERSION, type NativeRun } from './rendererProvenance';
import { surfaceShadingOf } from './surfaceShading';
import { encodeVideo } from './animation/encodeVideo';
import { analyseMotion } from './animation/analysis';
import { buildCameraPlan, resolveCamera, type CameraPlan, type ResolvedCamera } from './animation/cameraPlan';
import { renderAllFrames } from './animation/frameLoop';
import { overlayFont } from './animation/overlayText';
import { animationRejection } from './animation/refusals';
import { buildSheet, cellSize, sheetFrames } from './animation/sheet';
import { clipSource } from './animation/clipSource';
import { simulationSource } from './animation/simulationSource';
import { stillSource } from './animation/stillSource';
import { sweepSource } from './animation/sweepSource';
import { frameCountOf } from './animation/timeline';
import type { AnimationWarning, MotionFrames, OverlayIds, SourceRefusal } from './animation/types';
import type { renderAnimationParams } from './renderAnimationSchema';

const DEFAULT_FPS = 30;
const DEFAULT_ACCENT = '#ff9f1c';
const DEFAULT_BACKGROUND = '#1a1a2e';
const MAX_FRAMES = 1800;
const MAX_GIF_FPS = 50;
/** Named guard: frames × width × height above this is refused for frames / apng (MOV_RENDER_BUDGET). */
const MAX_TOTAL_PIXELS = 100_000_000;

const hexOf = (rgb: readonly number[]): string => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

type Params = z.infer<typeof renderAnimationParams>;
type Fail = (
  code: string,
  message: string,
  ids?: readonly string[],
  paths?: readonly string[],
  warnings?: readonly AnimationWarning[],
) => CommandResult;
type Color = [number, number, number];
type Media = NonNullable<ExecutionContext['media']>;
type Raster = NonNullable<ExecutionContext['raster']>;

const isResult = (value: object): value is CommandResult => 'document' in value;

interface Output {
  readonly format: NonNullable<Params['format']>;
  readonly askedFps: number;
  readonly fps: number;
  readonly askedWidth: number;
  readonly askedHeight: number;
  readonly width: number;
  readonly height: number;
}

function outputOf(params: Params): Output {
  const format = params.format ?? 'mp4';
  // GIF delays are whole centiseconds and viewers clamp 1 cs to 10 cs: above 50 fps the whole animation is made at 50 fps
  const askedFps = params.fps ?? DEFAULT_FPS;
  const fps = format === 'gif' ? Math.min(askedFps, MAX_GIF_FPS) : askedFps;
  const askedWidth = clamp(Math.round(params.width ?? 1280), 64, 1920);
  const askedHeight = clamp(Math.round(params.height ?? 720), 64, 1080);
  // 4:2:0 needs even sides: an odd mp4 size is rounded down by one
  const width = format === 'mp4' ? askedWidth - (askedWidth % 2) : askedWidth;
  const height = format === 'mp4' ? askedHeight - (askedHeight % 2) : askedHeight;
  return { format, askedFps, fps, askedWidth, askedHeight, width, height };
}

interface Request {
  readonly resolved: Exclude<ResolvedCamera, never>;
  readonly background: Color;
  readonly accent: Color;
}

function checkRequest(doc: CadDocument, params: Params, fail: Fail): Request | CommandResult {
  const resolved = resolveCamera(doc, params.camera ?? {});
  if ('refused' in resolved) return fail(resolved.refused.code, resolved.refused.message, resolved.refused.ids, ['camera']);
  if (params.source.kind === 'still' && (resolved.mode === 'fixed' || resolved.mode === 'viewpoint'))
    return fail(
      'MOV_NO_MOTION',
      'a still source with a fixed camera shows the same picture in every frame: give camera.walkthroughId or camera.orbit',
      [],
      ['camera'],
    );
  const background = hexRgb(params.background ?? DEFAULT_BACKGROUND);
  if (background === null)
    return fail('MOV_RENDER_INVALID', `background "${params.background ?? ''}" is not #rgb or #rrggbb`, [], ['background']);
  const accent = hexRgb(params.overlays?.accent ?? DEFAULT_ACCENT);
  if (accent === null)
    return fail('MOV_RENDER_INVALID', `accent "${params.overlays?.accent ?? ''}" is not #rgb or #rrggbb`, [], ['overlays.accent']);
  return { resolved, background, accent };
}

interface Budget {
  readonly playbackRate: number;
  readonly frames: number;
  readonly media: Media | undefined;
  readonly native: Raster | undefined;
}

function checkBudget(params: Params, out: Output, ctx: ExecutionContext | undefined, fail: Fail): Budget | CommandResult {
  const { source } = params;
  const { format, fps, width, height } = out;
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
  return { playbackRate, frames, media, native };
}

function makeSource(
  doc: CadDocument,
  params: Params,
  ids: OverlayIds,
  ctx: ExecutionContext | undefined,
  budget: Budget,
  fps: number,
): MotionFrames | SourceRefusal {
  const { source } = params;
  const { playbackRate, frames } = budget;
  switch (source.kind) {
    case 'simulation':
      return simulationSource(doc, { duration: source.duration, timestep: source.timestep, playbackRate, fps, frames }, ids, ctx);
    case 'sweep':
      return sweepSource(
        doc,
        { mode: source.mode, target: source.target, start: source.start, end: source.end, pingPong: source.pingPong === true, fps, frames },
        ids,
      );
    case 'clips':
      return clipSource(doc, { fps, frames }, ids);
    case 'still':
      return stillSource(doc, { fps, frames }, ids);
  }
}

function warningsOf(motion: MotionFrames, plan: CameraPlan, out: Output, textMissing: boolean): AnimationWarning[] {
  const { askedWidth, askedHeight, width, height, askedFps, fps } = out;
  const warnings: AnimationWarning[] = [...motion.warnings, ...plan.warnings];
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
  if (textMissing)
    warnings.push({
      code: 'MOV_OVERLAY_TEXT_SKIPPED',
      message: 'no bundled font in this host (ctx.fonts): time labels, readout text, trace names and sheet labels are not drawn',
    });
  return warnings;
}

interface Encoded {
  readonly files: { fileName: string; base64: string }[];
  readonly fileSha256: string | undefined;
  readonly encoder: MediaEncoder | undefined;
}

interface EncodeInput {
  readonly params: Params;
  readonly out: Output;
  readonly frames: number;
  readonly media: Media | undefined;
  readonly pngs: readonly Uint8Array[];
  readonly native: NativeRun | null;
  readonly warnings: readonly AnimationWarning[];
  readonly fail: Fail;
}

function encodeFiles(input: EncodeInput): Encoded | CommandResult {
  const { params, out, frames, media, pngs, native, warnings, fail } = input;
  const { format, width, height, fps } = out;
  const videoFormat = format === 'gif' || format === 'mp4' ? format : null;
  const files: { fileName: string; base64: string }[] = [];
  let fileSha256: string | undefined;
  let encoder: MediaEncoder | undefined;
  if (format === 'apng') {
    const apng = encodeApng(pngs, fps);
    if (apng === null) return fail('MOV_ENCODE_FAILED', 'the APNG writer rejected the frames');
    files.push({ fileName: 'animation.apng', base64: uint8ArrayToBase64(apng) });
    if (native === null) fileSha256 = sha256Hex(apng);
  } else if (media !== undefined && videoFormat !== null) {
    const video = encodeVideo(media, { format: videoFormat, width, height, fps, quality: params.quality ?? 'standard', frames }, pngs);
    if (!video.ok) return fail(video.code, video.message, [], ['format'], warnings);
    files.push({ fileName: `animation.${format}`, base64: uint8ArrayToBase64(video.bytes) });
    encoder = video.encoder;
    if (native === null && video.encoder.deterministic) fileSha256 = sha256Hex(video.bytes);
  } else {
    pngs.forEach((png, k) => files.push({ fileName: `frame-${String(k + 1).padStart(4, '0')}.png`, base64: uint8ArrayToBase64(png) }));
  }
  return { files, fileSha256, encoder };
}

interface Delivery {
  readonly doc: CadDocument;
  readonly params: Params;
  readonly out: Output;
  readonly budget: Budget;
  readonly motion: MotionFrames;
  readonly plan: CameraPlan;
  readonly timeline: MotionFrames['timeline'];
  readonly moving: readonly string[];
  readonly warnings: readonly AnimationWarning[];
  readonly encoded: Encoded;
  readonly sheetData: { frames: number[]; columns: number; width: number; height: number } | undefined;
  readonly pngs: readonly Uint8Array[];
  readonly native: NativeRun | null;
}

function deliver(d: Delivery): CommandResult {
  const { doc, params, out, budget, motion, plan, timeline, moving, warnings, encoded, sheetData, pngs, native } = d;
  const { frames, playbackRate } = budget;
  const { fps, width, height, format } = out;
  const { source } = params;
  const base = {
    frames,
    fps,
    videoDurationS: frames / fps,
    sourceDurationS: source.duration,
    playbackRate,
    width,
    height,
    format,
    camera: plan.cameraAt(0),
    cameraMode: plan.mode,
    files: encoded.files,
    timeline,
    moving,
    ...(motion.traces.length === 0
      ? {}
      : {
          traces: Object.fromEntries(
            motion.traces.map((trace) => [trace.id, { path: trace.path.map((p) => p.map(round6)), at: trace.at }]),
          ),
        }),
    ...(sheetData === undefined ? {} : { sheet: sheetData }),
    ...(encoded.encoder === undefined ? {} : { encoder: encoded.encoder }),
    ...(motion.sampleIntervalS === undefined ? {} : { sampleIntervalS: motion.sampleIntervalS }),
    warnings,
  };
  const summary =
    `render_animation: ${frames} frame(s) at ${fps} fps (${+(frames / fps).toFixed(4)} s of video, ${source.kind} ${source.duration} s${playbackRate === 1 ? '' : ` at playbackRate ${playbackRate}`}), ${width}×${height}, ` +
    `${plan.mode} camera, format ${format}; ${moving.length} moving entit${moving.length === 1 ? 'y' : 'ies'}` +
    `${warnings.length === 0 ? '' : `; warnings: ${warnings.map((w) => w.code).join(', ')}`}. Save the files with --save <dir>/ (or --save out.${format === 'frames' ? 'png' : format}).`;
  if (native === null)
    return report(doc, summary, {
      ...base,
      renderer: 'reference',
      rendererVersion: REFERENCE_RENDERER_VERSION,
      frameSha256: pngs.map((png) => sha256Hex(png)),
      ...(encoded.fileSha256 === undefined ? {} : { fileSha256: encoded.fileSha256 }),
    });
  return report(doc, `${summary} (native pictures, no digests)`, { ...base, ...native.result() });
}

export function runRenderAnimation(doc: CadDocument, params: Params, ctx: ExecutionContext | undefined): CommandResult {
  const fail: Fail = (code, message, ids = [], paths = [], warnings = []) =>
    animationRejection(doc, 'render_animation', code, message, ids, paths, warnings.length === 0 ? undefined : { warnings });
  const { source } = params;
  const out = outputOf(params);
  const { fps, width, height } = out;
  const request = checkRequest(doc, params, fail);
  if (isResult(request)) return request;
  const budget = checkBudget(params, out, ctx, fail);
  if (isResult(budget)) return budget;
  const { frames } = budget;

  const ids: OverlayIds = { trace: params.overlays?.trace ?? [], readouts: params.overlays?.readouts ?? [] };
  const motion = makeSource(doc, params, ids, ctx, budget, fps);
  if ('refused' in motion) return fail(motion.refused.code, motion.refused.message, motion.refused.ids, [], motion.refused.warnings);

  const analysis = analyseMotion(motion, source.kind === 'still' ? 1 : frames);
  if (analysis.bounds === null || (source.kind !== 'still' && analysis.moving.length === 0))
    return fail(
      'MOV_NO_MOTION',
      `${analysis.bounds === null ? 'there is nothing to draw' : `nothing moves during the ${source.kind} run (every entity keeps its pose in all ${frames} frames)`}`,
      [],
      [],
      motion.warnings,
    );
  const plan = buildCameraPlan(request.resolved, analysis.bounds, width, height, fps, frames);
  const timeline = plan.moves ? motion.timeline.map((entry, k) => ({ ...entry, camera: plan.cameraAt(k) })) : motion.timeline;
  const colorOverrides =
    params.overlays?.highlight === 'moving' ? Object.fromEntries(analysis.moving.map((id) => [id, hexOf(request.accent)])) : undefined;
  const font: ParsedFont | null = overlayFont(ctx);
  const wantsText = params.overlays?.time === true || ids.readouts.length > 0 || ids.trace.length > 0 || params.sheet !== undefined;
  const warnings = warningsOf(motion, plan, out, wantsText && font === null);
  const native = budget.native === undefined ? null : nativeRun(budget.native, 'gpu');
  const picked = params.sheet === undefined ? [] : sheetFrames(frames, params.sheet.every);
  const drawn = renderAllFrames({
    motion,
    frames,
    width,
    height,
    cameraAt: plan.cameraAt,
    cameraMoves: plan.moves,
    bounds: analysis.bounds,
    background: request.background,
    pixels: native?.pixels,
    shading: surfaceShadingOf(doc, ctx),
    colorOverrides,
    font,
    time: params.overlays?.time === true,
    sheetFrames: new Set(picked),
  });
  if (native !== null) {
    const outcome = native.result();
    if ('code' in outcome) return fail(outcome.code, outcome.message, [], ['renderer']);
  }
  const encoded = encodeFiles({ params, out, frames, media: budget.media, pngs: drawn.pngs, native, warnings, fail });
  if (isResult(encoded)) return encoded;
  encoded.files.push({
    fileName: 'timeline.json',
    base64: textToBase64(JSON.stringify({ fps, playbackRate: budget.playbackRate, frames, timeline })),
  });
  let sheetData: Delivery['sheetData'];
  if (params.sheet !== undefined) {
    const sheet = buildSheet(drawn.cells, cellSize(width, height), font);
    encoded.files.push({ fileName: 'sheet.png', base64: uint8ArrayToBase64(sheet.png) });
    sheetData = { frames: picked, columns: sheet.columns, width: sheet.width, height: sheet.height };
  }
  return deliver({
    doc,
    params,
    out,
    budget,
    motion,
    plan,
    timeline,
    moving: analysis.moving,
    warnings,
    encoded,
    sheetData,
    pngs: drawn.pngs,
    native,
  });
}
