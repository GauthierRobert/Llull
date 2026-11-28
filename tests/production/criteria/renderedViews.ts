import type { CadDocument } from '@core/model/types';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import { readExrHeader } from '../oracle/exr';
import { decodePng, lumaSpread, meanAbsoluteDifference, type DecodedImage } from '../oracle/png';
import { frameDeliverable, viewDeliverable, type RenderIntent } from '../render/intent';

/**
 * Visualisation-job criteria (RV1 §7 V6): the appearance library is in the document and on the plant elements; the six views and the
 * turntable frames are real pictures (independent PNG / EXR readers), at the brief's settings, distinct, with their provenance recorded.
 * Render deliverables are the render_realistic `data` as JSON (`render:view:<name>`, `render:turntable:<k>`).
 */

interface RenderData {
  readonly files?: readonly { readonly name: string; readonly base64: string }[];
  readonly illustration?: boolean;
  readonly deterministic?: boolean;
  readonly samples?: number;
  readonly seed?: number;
  readonly device?: string;
  readonly version?: string;
  readonly width?: number;
  readonly height?: number;
  readonly error?: string;
}

const pass = (detail: string): CheckOutcome => ({ pass: true, detail });
const fail = (detail: string): CheckOutcome => ({ pass: false, detail });

function renderData(ctx: GradeContext, id: string): RenderData {
  const text = ctx.deliverable(id);
  return text === '' ? { error: 'empty deliverable' } : (JSON.parse(text) as RenderData);
}

function fileOf(data: RenderData, name: string): Uint8Array | null {
  const file = data.files?.find((entry) => entry.name === name);
  return file === undefined ? null : new Uint8Array(Buffer.from(file.base64, 'base64'));
}

function picture(ctx: GradeContext, id: string, intent: RenderIntent): DecodedImage | string {
  const data = renderData(ctx, id);
  if (data.error !== undefined) return `${id}: ${data.error}`;
  const png = fileOf(data, 'render.png');
  if (png === null) return `${id}: no render.png`;
  try {
    const image = decodePng(png);
    if (image.width !== intent.width || image.height !== intent.height)
      return `${id}: PNG ${image.width} x ${image.height}, brief ${intent.width} x ${intent.height}`;
    return image;
  } catch (error) {
    return `${id}: ${(error as Error).message}`;
  }
}

/** Library appearance each plant entity resolves to (entity override, else its material's), by the brief's category mapping. */
function coverage(doc: CadDocument, intent: RenderIntent): { covered: number; total: number; missing: string[] } {
  const wanted = new Map(intent.library.flatMap((entry) => entry.categories.map((category) => [category, entry] as const)));
  let covered = 0;
  let total = 0;
  const missing: string[] = [];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    const category = entity?.tags?.find((tag) => wanted.has(tag as never));
    if (entity === undefined || category === undefined) continue;
    const entry = wanted.get(category as never);
    if (entry === undefined) continue;
    total++;
    const viaMaterial = entity.materialId === entry.material;
    const viaOverride = entity.appearance?.libraryId === entry.appearance;
    if (viaMaterial || viaOverride) covered++;
    else if (missing.length < 3) missing.push(`${id} (${category})`);
  }
  return { covered, total, missing };
}

export function renderedViewCriteria(intent: RenderIntent): Criterion[] {
  const views = intent.views.map(viewDeliverable);
  const frames = Array.from({ length: intent.turntable.frames }, (_, frame) => frameDeliverable(frame));
  return [
    {
      id: 'appearance-library',
      area: 'visualization',
      requirement: 'The office appearance library exists as materials with the brief appearance (library id, paint colour).',
      check: ({ document }) => {
        const wrong = intent.library.filter((entry) => {
          const appearance = document.materials?.[entry.material]?.appearance;
          return appearance?.libraryId !== entry.appearance || (entry.color !== undefined && appearance.baseColor?.value !== entry.color);
        });
        return wrong.length === 0
          ? pass(`${intent.library.length} library materials with their appearance`)
          : fail(`missing or wrong: ${wrong.map((entry) => entry.material).join(', ')}`);
      },
    },
    {
      id: 'appearance-coverage',
      area: 'visualization',
      requirement: 'Every plant element (members, pipes, tray, supports) renders with the appearance the brief assigns to its category.',
      check: ({ document }) => {
        const { covered, total, missing } = coverage(document, intent);
        if (total === 0) return fail('no plant element found');
        return covered === total
          ? pass(`${total} element solids wear their library appearance`)
          : fail(`${covered} / ${total} element solids wear their appearance; e.g. ${missing.join(', ')}`);
      },
    },
    {
      id: 'rendered-views',
      area: 'visualization',
      requirement: `Six views (${intent.views.join(', ')}) issued as PNG + scene-linear EXR at ${intent.width} x ${intent.height}.`,
      check: (ctx) => {
        const problems: string[] = [];
        for (const id of views) {
          const image = picture(ctx, id, intent);
          if (typeof image === 'string') problems.push(image);
          else if (lumaSpread(image) < 4) problems.push(`${id}: blank picture`);
          const exr = fileOf(renderData(ctx, id), 'render.exr');
          if (exr === null) problems.push(`${id}: no render.exr`);
          else {
            try {
              const header = readExrHeader(exr);
              const rgb = ['R', 'G', 'B'].every((channel) => header.channels[channel] !== undefined);
              if (header.width !== intent.width || header.height !== intent.height || !rgb)
                problems.push(`${id}: EXR ${header.width} x ${header.height}, channels ${Object.keys(header.channels).join('')}`);
            } catch (error) {
              problems.push(`${id}: ${(error as Error).message}`);
            }
          }
        }
        return problems.length === 0 ? pass(`${views.length} views, PNG + EXR, not blank`) : fail(problems.slice(0, 4).join('; '));
      },
    },
    {
      id: 'views-distinct',
      area: 'visualization',
      requirement: 'The six views are six different pictures (no two views alike).',
      check: (ctx) => {
        const images = views.map((id) => picture(ctx, id, intent));
        const decoded = images.filter((image): image is DecodedImage => typeof image !== 'string');
        if (decoded.length !== views.length) return fail('a view is missing');
        let closest = Infinity;
        for (let a = 0; a < decoded.length; a++)
          for (let b = a + 1; b < decoded.length; b++)
            closest = Math.min(closest, meanAbsoluteDifference(decoded[a] as DecodedImage, decoded[b] as DecodedImage));
        return closest >= 2
          ? pass(`closest pair differs by ${closest.toFixed(1)} / 255`)
          : fail(`two views differ by only ${closest.toFixed(2)} / 255`);
      },
    },
    {
      id: 'turntable',
      area: 'visualization',
      requirement: `A turntable of ${intent.turntable.frames} frames: each frame closer to the next one than to the frame a quarter turn on (a rotation, in order; a quarter, not a half turn, since a plant is often near-symmetric).`,
      check: (ctx) => {
        const images = frames.map((id) => picture(ctx, id, intent));
        const bad = images.find((image): image is string => typeof image === 'string');
        if (bad !== undefined) return fail(bad);
        const decoded = images as DecodedImage[];
        const n = decoded.length;
        let ordered = 0;
        for (let k = 0; k < n; k++) {
          const here = decoded[k] as DecodedImage;
          const next = meanAbsoluteDifference(here, decoded[(k + 1) % n] as DecodedImage);
          const quarter = meanAbsoluteDifference(here, decoded[(k + Math.round(n / 4)) % n] as DecodedImage);
          if (next > 0.5 && next < quarter) ordered++;
        }
        return ordered === n
          ? pass(`${n} frames in rotation order`)
          : fail(`${ordered} / ${n} frames closer to the next frame than to the quarter-turn one`);
      },
    },
    {
      id: 'render-provenance',
      area: 'visualization',
      requirement: `Every render is marked an illustration and records seed ${intent.seed}, ${intent.samples} samples, device, version, deterministic.`,
      check: (ctx) => {
        const problems = [...views, ...frames].flatMap((id) => {
          const data = renderData(ctx, id);
          const ok =
            data.illustration === true &&
            data.deterministic === true &&
            data.seed === intent.seed &&
            data.samples === intent.samples &&
            typeof data.device === 'string' &&
            typeof data.version === 'string';
          return ok ? [] : [`${id}: ${data.error ?? JSON.stringify({ ...data, files: undefined })}`];
        });
        return problems.length === 0
          ? pass(`${views.length + frames.length} renders with full provenance`)
          : fail(problems.slice(0, 3).join('; '));
      },
    },
  ];
}
