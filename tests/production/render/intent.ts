/**
 * Design intent of the visualisation job (RV1 §7 layer V6): the issued pipe-rack model (desmet-pipe-rack) gets the office's appearance
 * library, a site sun and sky, six rendered views and a turntable. The brief, the script and the criteria all come from this one record.
 */

type NamedView = 'front' | 'back' | 'left' | 'right' | 'top' | 'iso';

/** Plant element categories (the `bim` tag after `element:` lookups: member, pipe, tray, pipeSupport). */
type ElementCategory = 'member' | 'pipe' | 'tray' | 'pipeSupport';

interface LibraryEntry {
  /** Material of the office library (create_material name). */
  readonly material: string;
  /** Offline library appearance id (apply_appearance). */
  readonly appearance: string;
  readonly color?: string;
  /** Element categories that wear it. */
  readonly categories: readonly ElementCategory[];
}

export interface RenderIntent {
  readonly title: string;
  readonly site: { readonly latitudeDeg: number; readonly longitudeDeg: number; readonly dateTime: string };
  readonly library: readonly LibraryEntry[];
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly seed: number;
  /** Magnification over render_realistic's framing of the whole model (a 54 m rack fills about half the frame at 1; 1.8 crops the end-on turntable frames). */
  readonly zoom: number;
  readonly views: readonly NamedView[];
  /** Frames at equal azimuth steps around the model, looking down at `elevation` (z of the unit-ish view direction). */
  readonly turntable: { readonly frames: number; readonly elevation: number };
}

export const renderIntent: RenderIntent = {
  title: 'Pipe rack — rendered views and turntable for the client review',
  site: { latitudeDeg: 51.05, longitudeDeg: 3.72, dateTime: '2026-06-21T15:00:00+02:00' },
  library: [
    { material: 'S355 painted', appearance: 'painted', color: '#c9a227', categories: ['member'] },
    { material: 'Pipe galvanised', appearance: 'galvanised', categories: ['pipe'] },
    { material: 'Tray galvanised', appearance: 'galvanised', categories: ['tray'] },
    { material: 'Support steel', appearance: 'steel', categories: ['pipeSupport'] },
  ],
  width: 480,
  height: 270,
  samples: 16,
  seed: 7,
  zoom: 1.4,
  views: ['front', 'back', 'left', 'right', 'top', 'iso'],
  turntable: { frames: 12, elevation: 0.45 },
};

/** Deliverable id of a named view and of a turntable frame (graded through `GradeContext.deliverable`). */
export const viewDeliverable = (view: NamedView): string => `render:view:${view}`;
export const frameDeliverable = (frame: number): string => `render:turntable:${frame}`;

/** Unit-length horizontal direction of turntable frame `frame`, raised by the intent elevation. */
function frameDirection(intent: RenderIntent, frame: number): [number, number, number] {
  const angle = (2 * Math.PI * frame) / intent.turntable.frames;
  const round = (value: number): number => Math.round(value * 1e9) / 1e9;
  return [round(Math.cos(angle)), round(Math.sin(angle)), intent.turntable.elevation];
}

/** render_realistic params of a deliverable id (`render:view:<name>` or `render:turntable:<k>`). */
export function renderParams(intent: RenderIntent, id: string): Record<string, unknown> {
  const [, kind = '', arg = ''] = id.split(':');
  const common = {
    width: intent.width,
    height: intent.height,
    samples: intent.samples,
    seed: intent.seed,
    zoom: intent.zoom,
    denoise: true,
  };
  if (kind === 'view') return { ...common, view: arg, exr: true };
  if (kind === 'turntable') return { ...common, direction: frameDirection(intent, Number(arg)), exr: false };
  throw new Error(`unknown render deliverable ${id}`);
}
