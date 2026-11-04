/**
 * render_view overlay "clouds" (plant 10 SCN-M3c): the attached point clouds drawn as small SVG marks, read through the host point-cloud port.
 * Placement and registration are the cloud transform of `query_cloud_points`; crops (`set_scan_crop`), the section box / cut and review dimming apply.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { CloudQuery } from '@core/model/pointCloud';
import type { OverlayLayer, OverlayView, RenderOverlay } from '@core/model/renderOverlay';
import { z } from 'zod';
import { clamp } from '@lib/clamp';
import { classColour, grey, rgbColour, viridis } from './cloudColour';
import { applyPoint } from './mat4';
import { cloudsOf, scanOf, vecFromM } from './model';
import type { CloudReference, CropBox } from './types';

type Colour = 'elevation' | 'rgb' | 'intensity' | 'classification';

interface Sample {
  readonly p: Vec3;
  readonly rgb?: readonly [number, number, number];
  readonly intensity?: number;
  readonly classification?: number;
}

interface CloudSamples {
  readonly cloud: CloudReference;
  readonly colour: Colour;
  readonly samples: Sample[];
  readonly queried: number;
  readonly cropped: number;
  readonly truncated: boolean;
  readonly note?: string;
}

const insideBox = (box: CropBox, p: Vec3): boolean =>
  [0, 1, 2].every((a) => (p[a] ?? 0) >= (box.min[a] ?? 0) && (p[a] ?? 0) <= (box.max[a] ?? 0));

const empty = (note: string, extra: Record<string, unknown>): OverlayLayer => ({
  svg: [],
  stats: { entities: [], lines: 0, points: 0, detail: { drawn: 0, clouds: [], note, ...extra } },
});

/** Columns a colour mode needs from the asset (elevation needs none). */
const columnOf: Readonly<Record<Colour, 'rgb' | 'intensity' | 'classification' | null>> = {
  elevation: null,
  rgb: 'rgb',
  intensity: 'intensity',
  classification: 'classification',
};

function sampleCloud(
  doc: CadDocument,
  view: OverlayView,
  cloud: CloudReference,
  wanted: Colour,
  share: number,
  crops: readonly CropBox[],
): CloudSamples | string {
  const port = view.ports?.pointClouds;
  const manifest = port?.manifest(cloud.assetKey) ?? null;
  if (port === null || port === undefined || manifest === null) return `${cloud.id}: its asset is not in this machine's store`;
  const column = columnOf[wanted];
  const present = column !== null && manifest.attributes.includes(column);
  const colour: Colour = column === null || present ? wanted : 'elevation';
  const filtering = view.cutKeep !== undefined || crops.length > 0;
  const budget = share * (filtering ? 4 : 1);
  const query: CloudQuery = { lod: { budget }, maxPoints: budget, ...(present ? { attributes: [column] } : {}) };
  const read = port.query(cloud.assetKey, query);
  if (read === null) return `${cloud.id}: its asset could not be read`;
  const kept: Sample[] = [];
  let cropped = 0;
  const count = read.indices.length;
  const columns = read.attributes;
  for (let i = 0; i < count; i++) {
    const p = vecFromM(
      doc,
      applyPoint(cloud.transform, [read.positions[3 * i] ?? 0, read.positions[3 * i + 1] ?? 0, read.positions[3 * i + 2] ?? 0]),
    );
    const hidden =
      (view.cutKeep !== undefined && !view.cutKeep(p)) ||
      crops.some((crop) => (insideBox(crop, p) ? crop.keep === 'outside' : crop.keep === 'inside'));
    if (hidden) {
      cropped++;
      continue;
    }
    if (colour === 'rgb' && columns?.rgb !== undefined)
      kept.push({ p, rgb: [columns.rgb[3 * i] ?? 0, columns.rgb[3 * i + 1] ?? 0, columns.rgb[3 * i + 2] ?? 0] });
    else if (colour === 'intensity' && columns?.intensity !== undefined) kept.push({ p, intensity: columns.intensity[i] ?? 0 });
    else if (colour === 'classification' && columns?.classification !== undefined)
      kept.push({ p, classification: columns.classification[i] ?? 0 });
    else kept.push({ p });
  }
  // Deterministic thinning to the share: evenly spaced picks in canonical order.
  const samples =
    kept.length <= share ? kept : Array.from({ length: share }, (_, k) => kept[Math.floor((k * kept.length) / share)] as Sample);
  const note = colour === wanted ? undefined : `${cloud.id} has no ${wanted} column: drawn by elevation`;
  return {
    cloud,
    colour,
    samples,
    queried: count,
    cropped,
    truncated: read.truncated || kept.length > share,
    ...(note === undefined ? {} : { note }),
  };
}

function colourOf(sample: Sample, colour: Colour, z: readonly [number, number], intensity: readonly [number, number]): string {
  if (colour === 'rgb' && sample.rgb !== undefined) return rgbColour(sample.rgb[0], sample.rgb[1], sample.rgb[2]);
  if (colour === 'classification' && sample.classification !== undefined) return classColour(sample.classification);
  if (colour === 'intensity' && sample.intensity !== undefined)
    return grey((sample.intensity - intensity[0]) / Math.max(1e-9, intensity[1] - intensity[0]));
  return viridis((sample.p[2] - z[0]) / Math.max(1e-9, z[1] - z[0]));
}

const range = (values: readonly number[]): [number, number] =>
  values.length === 0 ? [0, 1] : [values.reduce((a, b) => Math.min(a, b)), values.reduce((a, b) => Math.max(a, b))];

const fixed = (v: number): string => String(Math.round(v * 10) / 10);

/** Options of render_view `overlayOptions.clouds`. */
const cloudOptions = z.object({
  maxPoints: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Total point budget over all attached clouds, clamped to [100, 200000]. Default 20000. The SVG grows with it: about 2.8 MB at 200000 points, 0.3 MB at 20000. ' +
        'Under a cut / section box / crop that keeps less than 25% of a cloud the sample is thinner than the budget (the query is 4x the share).',
    ),
  colour: z
    .enum(['elevation', 'rgb', 'intensity', 'classification'])
    .optional()
    .describe(
      'Point colour: "elevation" (default, viridis over the drawn height range) or the stored "rgb", "intensity" (grey) or "classification" (ASPRS palette); a cloud without that column falls back to elevation (named in the summary).',
    ),
  pointSizePx: z.number().positive().optional().describe('Mark diameter in pixels, clamped to [1, 8]. Default 2.'),
});

/**
 * @invariant with `only` (isolate) a cloud is drawn only when the list names its cloud id
 * @invariant a pure query: the same document, port, request and view give the same marks (canonical node order, evenly spaced thinning, colours bucketed in sorted order)
 * @invariant no port, no attached (visible) cloud or an unreadable asset: nothing is drawn and detail.note says why (kernel-optional)
 * @invariant total drawn points never exceed maxPoints (clamped to [100, 200000]); each cloud gets maxPoints / clouds
 * @failure a missing colour column falls back to elevation and is named in detail.clouds[].note
 */
export const cloudOverlay: RenderOverlay = {
  kind: 'clouds',
  paramsSchema: cloudOptions,
  draw(doc, view): OverlayLayer {
    const request = cloudOptions.parse(view.options ?? {});
    const maxPoints = clamp(request.maxPoints ?? 20_000, 100, 200_000);
    const wanted: Colour = request.colour ?? 'elevation';
    const size = clamp(request.pointSizePx ?? 2, 1, 8);
    if (view.ports?.pointClouds === undefined || view.ports?.pointClouds === null)
      return empty('none drawn: no point-cloud port is installed in this host.', { maxPoints });
    const attached = cloudsOf(doc);
    const shown = attached.filter((cloud) => cloud.display.visible && (view.only === undefined || view.only.includes(cloud.id)));
    if (shown.length === 0)
      return empty(
        attached.length === 0
          ? 'none drawn: no cloud is attached.'
          : 'none drawn: every attached cloud is hidden or outside the isolate list.',
        { maxPoints },
      );
    const share = Math.max(1, Math.floor(maxPoints / shown.length));
    const crops = Object.values(scanOf(doc).crops);
    const skipped: string[] = [];
    const sets: CloudSamples[] = [];
    for (const cloud of shown) {
      const own = crops.filter((crop) => crop.cloudIds.length === 0 || crop.cloudIds.includes(cloud.id));
      const set = sampleCloud(doc, view, cloud, wanted, share, own);
      if (typeof set === 'string') skipped.push(set);
      else sets.push(set);
    }
    const all = sets.flatMap((set) => set.samples);
    const zRange = range(all.map((s) => s.p[2]));
    const intensityRange = range(all.flatMap((s) => (s.intensity === undefined ? [] : [s.intensity])));
    const width = view.size?.width ?? Infinity;
    const height = view.size?.height ?? Infinity;
    const svg: string[] = [];
    const report: Record<string, unknown>[] = [];
    const drawnIds: string[] = [];
    let drawn = 0;
    for (const set of sets) {
      const buckets = new Map<string, string[]>();
      let offscreen = 0;
      let marks = 0;
      for (const sample of set.samples) {
        const [x, y] = view.project(sample.p);
        if (!(x >= 0 && x <= width && y >= 0 && y <= height)) {
          offscreen++;
          continue;
        }
        const key = colourOf(sample, set.colour, zRange, intensityRange);
        const list = buckets.get(key) ?? [];
        list.push(`M${fixed(x)} ${fixed(y)}h0`);
        buckets.set(key, list);
        marks++;
      }
      drawn += marks;
      if (marks > 0) {
        drawnIds.push(set.cloud.id);
        svg.push(
          `  <g class="cloud-overlay" data-cloud="${set.cloud.id}" fill="none" stroke-width="${size}" stroke-linecap="round" opacity="${view.dim === true ? 0.3 : 0.9}">`,
          ...[...buckets.keys()].sort().map((key) => `    <path stroke="${key}" d="${(buckets.get(key) ?? []).join('')}"/>`),
          '  </g>',
        );
      }
      report.push({
        cloudId: set.cloud.id,
        colour: set.colour,
        queried: set.queried,
        cropped: set.cropped,
        sampled: set.samples.length,
        offscreen,
        drawn: marks,
        truncated: set.truncated,
        ...(set.note === undefined ? {} : { note: set.note }),
      });
    }
    const notes = [...sets.flatMap((set) => (set.note === undefined ? [] : [set.note])), ...skipped];
    const note = `${drawn} point(s) of ${sets.length} cloud(s) drawn (budget ${maxPoints}, ${wanted}).${notes.length === 0 ? '' : ` ${notes.join('; ')}.`}`;
    const detail = {
      maxPoints,
      colour: wanted,
      pointSizePx: size,
      drawn,
      clouds: report,
      ...(skipped.length === 0 ? {} : { skipped }),
      note,
    };
    return { svg, stats: { entities: drawnIds, lines: 0, points: drawn, detail } };
  },
};
