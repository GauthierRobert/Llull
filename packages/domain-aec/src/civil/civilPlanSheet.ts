/**
 * Civil plan sheet: every civil entity in plan at a true scale on ISO paper, clipped to the
 * drawing viewport, with grid ticks (calibrated sites), layer legend, north arrow, scale bar and
 * the shared title block.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument, Entity, Vec2 } from '@core/model/types';
import { escapeXml } from '@lib/escapeXml';
import {
  composeSheetSvg,
  fitScale,
  MARGIN,
  n,
  northArrow,
  PAPER_MM,
  sheetDrawingArea,
  type PaperSize,
  type Viewport,
} from '../sheet';
import { toMetres, toMm } from '../model';
import { niceStep } from './roadSvg';
import { clipPolyline, insideRect } from './planClip';
import { gridToLocal, localToGrid } from './crs';

export interface CivilSheetOptions {
  readonly paper: PaperSize;
  readonly scale: number | undefined;
  readonly center: Vec2 | undefined;
  readonly title: string | undefined;
  readonly layers: ReadonlyArray<string> | undefined;
}

export interface CivilPlanSheet {
  readonly text: string;
  readonly scale: number;
  readonly center: Vec2;
  readonly drawn: number;
  readonly clipped: number;
  readonly counts: Readonly<Record<'lines' | 'polylines' | 'points' | 'texts', number>>;
  readonly layers: ReadonlyArray<{ name: string; color: string; count: number }>;
}

const LEGEND_WIDTH = 52;

type Drawable = Entity & { kind: 'line' | 'polyline' | 'point' | 'text' };

const isDrawable = (entity: Entity): entity is Drawable =>
  entity.kind === 'line' ||
  entity.kind === 'polyline' ||
  entity.kind === 'point' ||
  entity.kind === 'text';

function worldPoints(entity: Drawable): Vec2[] {
  const cos = Math.cos(entity.rotation[2]);
  const sin = Math.sin(entity.rotation[2]);
  const place = ([x, y]: Vec2): Vec2 => [
    entity.position[0] + x * cos - y * sin,
    entity.position[1] + x * sin + y * cos,
  ];
  if (entity.kind === 'line') return [place(entity.start), place(entity.end)];
  if (entity.kind === 'polyline') return entity.points.map(place);
  return [[entity.position[0], entity.position[1]]];
}

/** Civil plan entities, in document order, restricted to `layerNames` when given. */
export function civilPlanEntities(
  doc: CadDocument,
  layerNames: ReadonlyArray<string> | undefined,
): Array<{ entity: Drawable; layer: string; color: string }> {
  const result: Array<{ entity: Drawable; layer: string; color: string }> = [];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (!entity?.tags?.includes('civil') || !isDrawable(entity)) continue;
    const layer = doc.layers[entity.layerId]?.name ?? '0';
    if (layerNames && !layerNames.includes(layer)) continue;
    result.push({
      entity,
      layer,
      color: entity.color ?? doc.layers[entity.layerId]?.color ?? '#000',
    });
  }
  return result;
}

function strokeWidth(layer: string): number {
  if (layer.includes('MAJR') || layer.includes('CNTR')) return 0.35;
  if (layer.includes('MINR') || layer.includes('TINN')) return 0.13;
  return 0.2;
}

function gridTicks(
  doc: CadDocument,
  scale: number,
  viewport: Viewport,
  center: Vec2,
  toPaper: (point: Vec2) => Vec2,
): string[] {
  const calibration = doc.civil?.crs?.calibration;
  if (!calibration) return [];
  const unitsPerMm = scale / toMm(doc, 1);
  const stepUnits = niceStep(40 * unitsPerMm * calibration.scaleFactor);
  const reach = Math.hypot(viewport.width, viewport.height) * unitsPerMm * calibration.scaleFactor;
  const gridCentre = localToGrid(calibration, center);
  const parts: string[] = [];
  const first = (value: number): number => Math.floor((value - reach) / stepUnits) * stepUnits;
  for (let easting = first(gridCentre[0]); easting <= gridCentre[0] + reach; easting += stepUnits) {
    for (
      let northing = first(gridCentre[1]);
      northing <= gridCentre[1] + reach;
      northing += stepUnits
    ) {
      const [x, y] = toPaper(gridToLocal(calibration, [easting, northing]));
      if (
        !insideRect([x, y], {
          x: viewport.x + 6,
          y: viewport.y + 4,
          width: viewport.width - 12,
          height: viewport.height - 8,
        })
      )
        continue;
      parts.push(
        `<path class="grid-tick" d="M${n(x - 2)} ${n(y)}H${n(x + 2)}M${n(x)} ${n(y - 2)}V${n(y + 2)}" stroke="#666" stroke-width="0.15" fill="none"/>`,
        `<text class="grid-label" x="${n(x + 1.5)}" y="${n(y - 1)}" font-size="1.8" fill="#444">${escapeXml(`E ${toMetres(doc, easting).toFixed(0)}  N ${toMetres(doc, northing).toFixed(0)}`)}</text>`,
      );
    }
  }
  return parts;
}

function legend(
  x: number,
  y: number,
  layers: ReadonlyArray<{ name: string; color: string; count: number }>,
): string {
  const rows = layers.map(
    (layer, index) =>
      `<rect x="${n(x + 2)}" y="${n(y + 8 + index * 4.5)}" width="6" height="2" fill="${escapeXml(layer.color)}"/>` +
      `<text x="${n(x + 10)}" y="${n(y + 9.8 + index * 4.5)}" font-size="2.2" text-anchor="start">${escapeXml(`${layer.name} (${layer.count})`)}</text>`,
  );
  return (
    `<g id="legend"><rect x="${n(x)}" y="${n(y)}" width="${LEGEND_WIDTH - 2}" height="${n(10 + layers.length * 4.5)}" class="frame-thin"/>` +
    `<text x="${n(x + 2)}" y="${n(y + 5)}" font-size="2.8" text-anchor="start">LEGEND</text>${rows.join('')}</g>`
  );
}

/**
 * Plan sheet of the civil entities of `doc`; null when there is nothing to draw, the scale is
 * not positive or no entity lies on the requested layers.
 * @pure
 */
export function buildCivilPlanSheet(
  doc: CadDocument,
  options: CivilSheetOptions,
): CivilPlanSheet | null {
  const items = civilPlanEntities(doc, options.layers);
  if (items.length === 0 || (options.scale !== undefined && !(options.scale > 0))) return null;
  const [width, height] = PAPER_MM[options.paper];
  const area = sheetDrawingArea(width, height);
  const viewport: Viewport = { ...area, width: area.width - LEGEND_WIDTH };
  const points = items.flatMap(({ entity }) => worldPoints(entity));
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
  const mmPerUnit = toMm(doc, 1);
  const center: Vec2 = options.center ?? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const scale =
    options.scale ??
    fitScale((bounds[2] - bounds[0]) * mmPerUnit, (bounds[3] - bounds[1]) * mmPerUnit, viewport);
  const perUnit = mmPerUnit / scale;
  const toPaper = ([x, y]: Vec2): Vec2 => [
    viewport.x + viewport.width / 2 + (x - center[0]) * perUnit,
    viewport.y + viewport.height / 2 - (y - center[1]) * perUnit,
  ];
  const counts = { lines: 0, polylines: 0, points: 0, texts: 0 };
  const perLayer = new Map<string, { name: string; color: string; count: number }>();
  const body: string[] = [];
  let clipped = 0;
  for (const { entity, layer, color } of items) {
    const stroke = `stroke="${escapeXml(color)}" stroke-width="${strokeWidth(layer)}" fill="none"`;
    const paper = worldPoints(entity).map(toPaper);
    let markup = '';
    if (entity.kind === 'line' || entity.kind === 'polyline') {
      const runs = clipPolyline(paper, entity.kind === 'polyline' && entity.closed, viewport);
      markup = runs
        .map(
          (run) =>
            `<polyline class="civil-line" points="${run.map((p) => p.map(n).join(',')).join(' ')}" ${stroke}/>`,
        )
        .join('');
      if (runs.length > 0) counts[entity.kind === 'line' ? 'lines' : 'polylines']++;
    } else if (paper[0] && insideRect(paper[0], viewport)) {
      const [x, y] = paper[0];
      if (entity.kind === 'point') {
        markup = `<path class="civil-point" d="M${n(x - 0.8)} ${n(y)}H${n(x + 0.8)}M${n(x)} ${n(y - 0.8)}V${n(y + 0.8)}" ${stroke}/>`;
        counts.points++;
      } else if (entity.kind === 'text') {
        const size = Math.min(Math.max(entity.height * perUnit, 1.8), 5);
        const turn = (-entity.rotation[2] * 180) / Math.PI;
        const anchor =
          entity.anchor === 'left' ? 'start' : entity.anchor === 'right' ? 'end' : 'middle';
        markup =
          `<text class="civil-text" x="${n(x)}" y="${n(y)}" font-size="${n(size)}" text-anchor="${anchor}" fill="${escapeXml(color)}"` +
          `${turn !== 0 ? ` transform="rotate(${n(turn)} ${n(x)} ${n(y)})"` : ''}>${escapeXml(entity.content)}</text>`;
        counts.texts++;
      }
    }
    if (markup === '') {
      clipped++;
      continue;
    }
    body.push(markup);
    const entry = perLayer.get(layer) ?? { name: layer, color, count: 0 };
    perLayer.set(layer, { ...entry, count: entry.count + 1 });
  }
  const layers = [...perLayer.values()];
  const title = options.title?.trim() || 'Civil plan';
  const clipId = 'civil-viewport';
  const text = composeSheetSvg(doc, {
    width,
    height,
    title,
    scale,
    paper: options.paper,
    caption: `${title} · 1:${scale} · levels and coordinates in m`,
    bodyId: 'civil-plan',
    body:
      `<clipPath id="${clipId}"><rect x="${n(viewport.x)}" y="${n(viewport.y)}" width="${n(viewport.width)}" height="${n(viewport.height)}"/></clipPath>` +
      `<g clip-path="url(#${clipId})">${body.join('')}${gridTicks(doc, scale, viewport, center, toPaper).join('')}</g>` +
      `<rect x="${n(viewport.x)}" y="${n(viewport.y)}" width="${n(viewport.width)}" height="${n(viewport.height)}" class="frame-thin"/>`,
    overlays: [
      northArrow(width - MARGIN - 12, MARGIN + 12),
      legend(viewport.x + viewport.width + 2, MARGIN + 28, layers),
    ],
  });
  return {
    text: `${text}\n`,
    scale,
    center,
    drawn: items.length - clipped,
    clipped,
    counts,
    layers,
  };
}
