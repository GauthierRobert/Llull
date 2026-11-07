// "Export animation…" form: its defaults (prefilled from the document and the playback transport) and the render_animation params it gathers.
// Param-gathering only: the command does the work (PRIME DIRECTIVE); nothing here builds an entity or touches the document.

import type { CadDocument } from '@core/model/types';
import { frameCountOf } from '@core/commands/render/animation/timeline';
import { parseNumber } from '@ui/numberText';

export type AnimationSourceKind = 'simulation' | 'sweep' | 'clips' | 'still';
export type AnimationFormat = 'mp4' | 'gif' | 'apng';
export type AnimationQuality = 'draft' | 'standard' | 'high';
export type AnimationView = 'iso' | 'front' | 'top' | 'right' | 'left' | 'back' | 'bottom';

export const SIZE_PRESETS = ['640x360', '1280x720', '1920x1080'] as const;
type AnimationSize = (typeof SIZE_PRESETS)[number];

/** Every field is the text or choice the user sees; `animationParams` turns it into render_animation params. */
export interface AnimationForm {
  source: AnimationSourceKind;
  duration: string;
  /** Simulated seconds per video second (simulation only). */
  playbackRate: string;
  sweepMode: 'joint' | 'parameter';
  target: string;
  start: string;
  end: string;
  pingPong: boolean;
  fps: string;
  size: AnimationSize;
  view: AnimationView;
  orbit: boolean;
  turns: string;
  loop: boolean;
  time: boolean;
  highlight: boolean;
  format: AnimationFormat;
  quality: AnimationQuality;
}

/** The playback transport the dialog starts from: the last simulated run and the speed chosen on the bar. */
export interface TransportState {
  readonly duration: number;
  readonly speed: number;
}

/** Video seconds a simulated run is stretched to by default (a 0.06 s crank turn becomes a readable 6 s). */
const TARGET_VIDEO_SECONDS = 6;
const PREVIEW_WIDTH = 480;
const PREVIEW_CELLS = 12;
const DEFAULT_FPS = '30';

const round = (value: number): string => String(Number(value.toPrecision(3)));

function sizeOf(size: AnimationSize): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number);
  return { width: width ?? 1280, height: height ?? 720 };
}

/** Prefill: the source the document can actually play, the transport's run length and speed when a simulation was played. */
export function defaultAnimationForm(document: CadDocument, transport: TransportState | null): AnimationForm {
  const hasBodies = Object.keys(document.dynamics?.bodies ?? {}).length > 0;
  const hasClips = Object.keys(document.animations).length > 0;
  const firstJoint = document.jointOrder[0] ?? '';
  const source: AnimationSourceKind = hasBodies ? 'simulation' : hasClips ? 'clips' : firstJoint !== '' ? 'sweep' : 'simulation';
  const duration = transport !== null ? transport.duration : 5;
  const rate = transport !== null ? Math.min(1, transport.speed) : Math.min(1, duration / TARGET_VIDEO_SECONDS);
  const revolute = document.joints[firstJoint]?.kind === 'revolute';
  return {
    source,
    duration: source === 'simulation' ? round(duration) : '4',
    playbackRate: round(rate),
    sweepMode: 'joint',
    target: firstJoint,
    start: '0',
    end: revolute ? '90' : '10',
    pingPong: true,
    fps: DEFAULT_FPS,
    size: '1280x720',
    view: 'iso',
    orbit: false,
    turns: '1',
    loop: true,
    time: true,
    highlight: false,
    format: 'mp4',
    quality: 'standard',
  };
}

/** What the video will be: frames and its length, from the numbers on the form; null while they are not valid. */
export function videoLengthOf(form: AnimationForm): { frames: number; seconds: number } | null {
  const duration = parseNumber(form.duration);
  const fps = parseNumber(form.fps);
  const rate = form.source === 'simulation' ? parseNumber(form.playbackRate) : 1;
  if (duration === undefined || fps === undefined || rate === undefined || duration <= 0 || fps < 1 || rate <= 0) return null;
  const frames = frameCountOf(duration, fps, rate);
  return { frames, seconds: frames / fps };
}

export type ParamsOutcome =
  | { readonly ok: true; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/** Revolute sweeps are typed in degrees (the command takes radians). */
function sweepSource(
  form: AnimationForm,
  document: CadDocument,
  duration: number,
): { source: Record<string, unknown> } | { message: string } {
  const start = parseNumber(form.start);
  const end = parseNumber(form.end);
  if (form.target.trim() === '') return { message: 'Name the joint or parameter to sweep.' };
  if (start === undefined || end === undefined) return { message: 'Start and end must be numbers.' };
  const degrees = form.sweepMode === 'joint' && document.joints[form.target]?.kind === 'revolute';
  const scale = degrees ? Math.PI / 180 : 1;
  return {
    source: {
      kind: 'sweep',
      mode: form.sweepMode,
      target: form.target.trim(),
      start: start * scale,
      end: end * scale,
      duration,
      pingPong: form.pingPong,
    },
  };
}

/**
 * The render_animation params for the form. `preview`: a small frame sequence with a contact sheet (the review loop of the spec); `save`: the chosen
 * format at the chosen size, nothing else.
 */
export function animationParams(form: AnimationForm, document: CadDocument, purpose: 'preview' | 'save'): ParamsOutcome {
  const duration = parseNumber(form.duration);
  const fps = parseNumber(form.fps);
  if (duration === undefined || duration <= 0) return { ok: false, message: 'Duration must be a positive number of seconds.' };
  if (fps === undefined || !Number.isInteger(fps) || fps < 1 || fps > 60)
    return { ok: false, message: 'Frames per second is a whole number from 1 to 60.' };
  let source: Record<string, unknown>;
  if (form.source === 'simulation') {
    const rate = parseNumber(form.playbackRate);
    if (rate === undefined || rate <= 0) return { ok: false, message: 'Playback rate must be a positive number.' };
    source = { kind: 'simulation', duration, playbackRate: rate };
  } else if (form.source === 'sweep') {
    const swept = sweepSource(form, document, duration);
    if ('message' in swept) return { ok: false, message: swept.message };
    source = swept.source;
  } else {
    source = { kind: form.source, duration };
  }
  const turns = parseNumber(form.turns);
  if (form.orbit && (turns === undefined || turns === 0)) return { ok: false, message: 'Orbit turns must be a non-zero number.' };
  if (form.source === 'still' && !form.orbit) return { ok: false, message: 'A still source needs the orbit camera: nothing else moves.' };
  const camera = { view: form.view, ...(form.orbit ? { orbit: { turns, loop: form.loop } } : {}) };
  const overlays = { time: form.time, highlight: form.highlight ? 'moving' : 'none' };
  const full = sizeOf(form.size);
  if (purpose === 'save')
    return {
      ok: true,
      params: { source, fps, width: full.width, height: full.height, camera, overlays, format: form.format, quality: form.quality },
    };
  const length = videoLengthOf(form);
  const every = Math.max(1, Math.ceil((length?.frames ?? PREVIEW_CELLS) / PREVIEW_CELLS));
  const width = Math.min(full.width, PREVIEW_WIDTH);
  return {
    ok: true,
    params: {
      source,
      fps,
      width,
      height: Math.round((width * full.height) / full.width),
      camera,
      overlays,
      format: 'frames',
      sheet: { every },
    },
  };
}
