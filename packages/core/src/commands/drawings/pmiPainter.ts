/**
 * PMI on drawing sheets (03 GDT TECHNICAL_SPEC §5.8): selects the PMI of a view, projects each annotation plane onto the view and paints the
 * frames, datum symbols and callouts in paper millimetres. Derived at export, never stored.
 * @invariant auto selection (pmiMode 'auto'): projection views that are not iso only, items whose annotation plane faces the viewer within 1
 *   degree and whose solid the view shows; explicit `view.pmiIds` override it; collisions are resolved greedily in paper space, deterministic
 */

import type { DrawingSheet, DrawingView } from '../../model/sheet';
import type { GeometricTolerancePmi, PmiItem } from '../../model/pmi';
import type { CadDocument, Vec2 } from '../../model/types';
import { directionFrame } from '../../geometry/viewDirections';
import { frameAnchor } from '../../geometry/pmiPlacement';
import {
  DIAMETER_GLYPH,
  type GlyphStroke,
  RING_GLYPH,
  TEXTURE_GLYPH,
  TRIANGLE_GLYPH,
  characteristicGlyph,
  placeGlyph,
} from '../../geometry/pmiSymbols';
import { ZONE_MODIFIER_TEXT, formatNumber, pmiText } from '../../geometry/pmiText';
import { n, svgLine, svgText } from '../../geometry/drawingSvg';
import { escapeXml } from '../../lib/escapeXml';
import { dot3 } from '../../lib/vec3';
import { characteristicBalloon } from './characteristicBalloon';
import { viewSolids } from './viewDrawing';
import { primaryFeature } from '../pmi/refresh';

const TEXT = 3.5;
const FRAME = 2 * TEXT;
const CHAR = 0.6 * TEXT;
const PARALLEL_COSINE = Math.cos((1 * Math.PI) / 180);

export type PmiSkipReason =
  | 'GDT_SHEET_PLANE_NOT_PARALLEL'
  | 'GDT_SHEET_SOLID_NOT_IN_VIEW'
  | 'GDT_SHEET_VIEW_KIND_UNSUPPORTED'
  | 'GDT_PMI_UNKNOWN';

export interface SheetPmiReport {
  readonly placed: Array<{ readonly viewId: string; readonly pmiIds: string[] }>;
  readonly skipped: Array<{ readonly pmiId: string; readonly reason: PmiSkipReason }>;
}

/** Whether PMI is drawn on this sheet at all. */
export const sheetShowsPmi = (sheet: DrawingSheet): boolean =>
  sheet.pmiMode === 'auto' || sheet.views.some((view) => view.pmiIds !== undefined);

const entityOf = (item: PmiItem, doc: CadDocument): string | undefined => primaryFeature(item, doc.pmi?.items ?? {})?.entityId;

/** Items of the document in creation order. */
const allItems = (doc: CadDocument): PmiItem[] =>
  (doc.pmi?.order ?? []).flatMap((id) => (doc.pmi?.items[id] === undefined ? [] : [doc.pmi.items[id]]));

/** Ids and reasons for one view: explicit list, else automatic selection (`reasons` per rejected item for the skip report). */
function select(doc: CadDocument, sheet: DrawingSheet, view: DrawingView): { ids: string[]; reasons: Map<string, PmiSkipReason> } {
  const reasons = new Map<string, PmiSkipReason>();
  if (view.pmiIds !== undefined) {
    const known = view.pmiIds.filter((id) => doc.pmi !== undefined && Object.hasOwn(doc.pmi.items, id));
    view.pmiIds.filter((id) => !known.includes(id)).forEach((id) => reasons.set(id, 'GDT_PMI_UNKNOWN'));
    return { ids: known, reasons };
  }
  if (sheet.pmiMode !== 'auto') return { ids: [], reasons };
  const items = allItems(doc);
  if (view.kind !== 'projection' || view.direction === undefined || view.direction === 'iso') {
    items.forEach((item) => reasons.set(item.id, 'GDT_SHEET_VIEW_KIND_UNSUPPORTED'));
    return { ids: [], reasons };
  }
  const toViewer = directionFrame(view.direction).toViewer;
  const shown = new Set(viewSolids(doc, view).map((entity) => entity.id));
  const ids: string[] = [];
  for (const item of items) {
    const entity = entityOf(item, doc);
    if (entity === undefined || !shown.has(entity)) reasons.set(item.id, 'GDT_SHEET_SOLID_NOT_IN_VIEW');
    else if (Math.abs(dot3(item.placement.plane.normal, toViewer)) < PARALLEL_COSINE) reasons.set(item.id, 'GDT_SHEET_PLANE_NOT_PARALLEL');
    else ids.push(item.id);
  }
  return { ids, reasons };
}

const textWidth = (text: string): number => Math.max(1, [...text].length * CHAR);

/** SVG of glyph strokes (`thin` lines, `solid` filled when `fill`). */
function strokes(glyph: readonly GlyphStroke[], x: number, y: number, size: number, fill = false): string[] {
  return placeGlyph(glyph, x, y, size).map((stroke) =>
    stroke.kind === 'circle'
      ? `<circle cx="${n(stroke.center[0])}" cy="${n(stroke.center[1])}" r="${n(stroke.radius)}" class="thin"/>`
      : `<${stroke.closed === true ? 'polygon' : 'polyline'} points="${stroke.points.map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" class="${fill ? 'solid' : 'thin'}"/>`,
  );
}

const ring = (x: number, y: number, size: number, letter: string): string[] => [
  ...strokes(RING_GLYPH, x, y, size),
  svgText(x + size / 2, y + size * 0.72, size * 0.6, 'middle', letter),
];

type ZonePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'diameter' }
  | { readonly kind: 'ring'; readonly letter: string };

/** The tolerance cell content of a feature control frame, in drawing order. */
function zoneParts(item: GeometricTolerancePmi): ZonePart[] {
  const { zone } = item;
  const parts: ZonePart[] = [];
  if (zone.diametral === true || zone.spherical === true) {
    parts.push({ kind: 'diameter' });
    if (zone.spherical === true) parts.push({ kind: 'text', text: 'S' });
  }
  parts.push({ kind: 'text', text: formatNumber(zone.value) });
  if (item.materialCondition !== 'RFS') parts.push({ kind: 'ring', letter: item.materialCondition === 'MMC' ? 'M' : 'L' });
  if (zone.projectedLength !== undefined)
    parts.push({ kind: 'ring', letter: 'P' }, { kind: 'text', text: formatNumber(zone.projectedLength) });
  for (const modifier of item.modifiers) {
    const label = ZONE_MODIFIER_TEXT[modifier][0];
    parts.push(
      modifier === 'free_state'
        ? { kind: 'ring', letter: 'F' }
        : modifier === 'tangent_plane'
          ? { kind: 'ring', letter: 'T' }
          : { kind: 'text', text: label },
    );
  }
  if (zone.unequallyDisposed !== undefined) parts.push({ kind: 'text', text: `UZ ${formatNumber(zone.unequallyDisposed)}` });
  return parts;
}

const partWidth = (part: ZonePart): number => (part.kind === 'text' ? textWidth(part.text) + 1 : FRAME * 0.55 + 1);

interface Painted {
  readonly parts: string[];
  /** Paper box [x, y, width, height] the item occupies. */
  readonly box: readonly [number, number, number, number];
  /** Where a leader leaves the item. */
  readonly anchor: Vec2;
}

/** A feature control frame with its top-left corner at (x, y). */
function paintFcf(item: GeometricTolerancePmi, x: number, y: number): Painted {
  const parts: string[] = [];
  const zone = zoneParts(item);
  const zoneWidth = zone.reduce((sum, part) => sum + partWidth(part), 1);
  const datumLabels = item.datums.map((datum) => ({
    datum,
    width: Math.max(FRAME, textWidth(datum.label) + (datum.boundary === undefined ? 2 : FRAME * 0.55 + 3)),
  }));
  const total = FRAME + zoneWidth + datumLabels.reduce((sum, d) => sum + d.width, 0);
  parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(total)}" height="${n(FRAME)}" class="thin"/>`);
  parts.push(...strokes(characteristicGlyph(item.characteristic), x + FRAME * 0.15, y + FRAME * 0.15, FRAME * 0.7));
  let cursor = x + FRAME;
  parts.push(svgLine([cursor, y], [cursor, y + FRAME], 'thin'));
  let at = cursor + 0.5;
  for (const part of zone) {
    if (part.kind === 'text') parts.push(svgText(at, y + FRAME * 0.68, TEXT, 'start', part.text));
    else if (part.kind === 'diameter') parts.push(...strokes(DIAMETER_GLYPH, at, y + FRAME * 0.2, FRAME * 0.6));
    else parts.push(...ring(at, y + FRAME * 0.22, FRAME * 0.55, part.letter));
    at += partWidth(part);
  }
  cursor += zoneWidth;
  for (const { datum, width } of datumLabels) {
    parts.push(svgLine([cursor, y], [cursor, y + FRAME], 'thin'), svgText(cursor + 1, y + FRAME * 0.68, TEXT, 'start', datum.label));
    if (datum.boundary !== undefined)
      parts.push(...ring(cursor + 1 + textWidth(datum.label) + 0.5, y + FRAME * 0.22, FRAME * 0.55, datum.boundary === 'MMB' ? 'M' : 'L'));
    cursor += width;
  }
  return { parts, box: [x, y, total, FRAME], anchor: [x, y + FRAME / 2] };
}

/** Datum feature symbol: letter in a square. */
function paintDatum(label: string, x: number, y: number): Painted {
  return {
    parts: [
      `<rect x="${n(x)}" y="${n(y)}" width="${n(FRAME)}" height="${n(FRAME)}" class="thin"/>`,
      svgText(x + FRAME / 2, y + FRAME * 0.7, TEXT, 'middle', label),
    ],
    box: [x, y, FRAME, FRAME],
    anchor: [x + FRAME / 2, y + FRAME],
  };
}

/** Datum target: circle with `A1`. */
function paintTarget(label: string, x: number, y: number): Painted {
  return {
    parts: [
      `<circle cx="${n(x + FRAME / 2)}" cy="${n(y + FRAME / 2)}" r="${n(FRAME / 2)}" class="thin"/>`,
      svgText(x + FRAME / 2, y + FRAME * 0.65, TEXT * 0.8, 'middle', label),
    ],
    box: [x, y, FRAME, FRAME],
    anchor: [x + FRAME / 2, y + FRAME],
  };
}

/** Plain text callout (size, location, texture, note). */
function paintText(text: string, x: number, y: number, symbol: readonly GlyphStroke[] | null): Painted {
  const width = textWidth(text) + (symbol === null ? 0 : FRAME);
  const parts = [
    ...(symbol === null ? [] : strokes(symbol, x, y, FRAME * 0.8)),
    svgText(x + (symbol === null ? 0 : FRAME), y + FRAME * 0.68, TEXT, 'start', text),
  ];
  return { parts, box: [x, y, width, FRAME], anchor: [x, y + FRAME / 2] };
}

function paintItem(item: PmiItem, x: number, y: number): Painted {
  switch (item.kind) {
    case 'geometric_tolerance':
      return paintFcf(item, x, y);
    case 'datum_feature':
      return paintDatum(item.label, x, y);
    case 'datum_target':
      return paintTarget(`${item.label}${item.targetNumber}`, x, y);
    case 'surface_texture':
      return paintText(pmiText(item), x, y, TEXTURE_GLYPH);
    default:
      return paintText(pmiText(item), x, y, null);
  }
}

const overlaps = (a: Painted['box'], b: Painted['box']): boolean =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** Arrow head of a leader ending at `tip`, pointing from `from`. */
function arrow(from: Vec2, tip: Vec2): string {
  const [dx, dy] = [tip[0] - from[0], tip[1] - from[1]];
  const length = Math.hypot(dx, dy) || 1;
  const [ux, uy] = [dx / length, dy / length];
  const base: Vec2 = [tip[0] - ux * 2.5, tip[1] - uy * 2.5];
  const side: Vec2 = [-uy * 0.9, ux * 0.9];
  return `<polygon points="${n(tip[0])},${n(tip[1])} ${n(base[0] + side[0])},${n(base[1] + side[1])} ${n(base[0] - side[0])},${n(base[1] - side[1])}" class="solid"/>`;
}

/**
 * Paints the PMI of `view`; `map` takes the view's projected model coordinates to paper mm.
 * @invariant items are painted in creation order; an item whose frame would overlap one already painted moves right by one frame height
 */
export function paintViewPmi(
  doc: CadDocument,
  sheet: DrawingSheet,
  view: DrawingView,
  map: (point: Vec2) => Vec2,
): { parts: string[]; placedIds: string[]; reasons: Map<string, PmiSkipReason> } {
  const { ids, reasons } = select(doc, sheet, view);
  const frame = directionFrame(view.direction ?? 'front');
  const project = (point: readonly [number, number, number]): Vec2 => map(frame.project(point));
  const boxes: Array<Painted['box']> = [];
  const body: string[] = [];
  for (const id of ids) {
    const item = doc.pmi?.items[id] as PmiItem;
    const [cx, cy] = project(frameAnchor(item.placement));
    let painted = paintItem(item, cx - 0, cy - FRAME / 2);
    for (let guard = 0; guard < 200 && boxes.some((box) => overlaps(painted.box, box)); guard++)
      painted = paintItem(item, painted.box[0] + FRAME, painted.box[1]);
    boxes.push(painted.box);
    const target = item.placement.leaderTo === undefined ? undefined : project(item.placement.leaderTo);
    const leader =
      target === undefined || item.kind === 'note'
        ? []
        : [
            svgLine(painted.anchor, target, 'thin'),
            ...(item.kind === 'datum_feature'
              ? strokes(TRIANGLE_GLYPH, target[0] - 1.5, target[1] - 3, 3, true)
              : [arrow(painted.anchor, target)]),
          ];
    body.push(
      `<g id="pmi-${escapeXml(item.id)}" data-kind="${item.kind}">${[...painted.parts, ...characteristicBalloon(doc, item.id, painted.box), ...leader].join('')}</g>`,
    );
  }
  return { parts: body, placedIds: ids, reasons };
}

/** The skip report of a sheet: PMI placed on no view, with the most telling reason. */
export function pmiReport(
  doc: CadDocument,
  sheet: DrawingSheet,
  placed: SheetPmiReport['placed'],
  reasons: ReadonlyMap<string, PmiSkipReason>[],
): SheetPmiReport {
  const done = new Set(placed.flatMap((entry) => entry.pmiIds));
  const priority: PmiSkipReason[] = [
    'GDT_SHEET_PLANE_NOT_PARALLEL',
    'GDT_SHEET_SOLID_NOT_IN_VIEW',
    'GDT_PMI_UNKNOWN',
    'GDT_SHEET_VIEW_KIND_UNSUPPORTED',
  ];
  const everyone = new Set([...(sheet.pmiMode === 'auto' ? (doc.pmi?.order ?? []) : []), ...reasons.flatMap((map) => [...map.keys()])]);
  const skipped = [...everyone]
    .filter((id) => !done.has(id))
    .map((pmiId) => ({
      pmiId,
      reason: priority.find((reason) => reasons.some((map) => map.get(pmiId) === reason)) ?? 'GDT_SHEET_SOLID_NOT_IN_VIEW',
    }));
  return { placed, skipped };
}
