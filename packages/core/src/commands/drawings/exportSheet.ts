/** Renders a sheet recipe to SVG: derive every view from the current model, lay out, paint. Nothing here is stored. */

import type { CadDocument, Vec2 } from '../../model/types';
import { MM_PER_UNIT } from '../../model/units';
import type { DrawingSheet, DrawingView } from '../../model/sheet';
import { type Bounds, type DerivedView, cuttingLine, deriveView } from './viewDrawing';
import { type Area, type PlacedView, layoutViews } from './layout';
import { composeSheet, sheetArea } from './sheetFrame';
import { DrawingPainter, n, paperDimension, svgLine, svgText } from '../../geometry/drawingSvg';
import { escapeXml } from '../../lib/escapeXml';
import { scaleText } from './sheetOps';
import { type PmiSkipReason, type SheetPmiReport, paintViewPmi, pmiReport, sheetShowsPmi } from './pmiPainter';

export interface SheetViewInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: DrawingView['kind'];
  /** Denominator N of the view's scale and its text ("1:2", "2:1"). */
  readonly scale: number;
  readonly scaleText: string;
  /** [minX, minY, maxX, maxY] of the view's geometry on the paper, millimetres. */
  readonly bounds: Bounds;
}

export interface RenderedSheet {
  readonly svg: string;
  /** Sheet scale denominator N. */
  readonly scale: number;
  readonly views: SheetViewInfo[];
  /** Views that could not be drawn (no solids, unknown parent), with the reason. */
  readonly skipped: Array<{ readonly id: string; readonly reason: string }>;
  /** Drawn views that look wrong (e.g. a detail circle with no geometry in it). */
  readonly warnings: string[];
  /** Whether every view lies inside the drawing area at this scale. */
  readonly fits: boolean;
  /** PMI placed per view and skipped (present only when the sheet draws PMI). */
  readonly pmi?: SheetPmiReport;
}

interface Drawn {
  readonly view: DrawingView;
  readonly derived: DerivedView;
}

const round2 = (value: number): number => Number(value.toFixed(2));

const center = (bounds: Bounds): Vec2 => [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];

/** Names every view crossing the drawing area, by how far, and the largest standard scale that fits. */
function overflowWarning(views: ReadonlyArray<SheetViewInfo>, area: Area, scale: number, fittingScale: number): string {
  const sides = ({ bounds }: SheetViewInfo): string[] =>
    [
      [area.x - bounds[0], 'left'],
      [area.y - bounds[1], 'top'],
      [bounds[2] - (area.x + area.width), 'right'],
      [bounds[3] - (area.y + area.height), 'bottom'],
    ].flatMap(([amount, side]) => ((amount as number) > 0.01 ? [`${round2(amount as number)} mm past the ${side as string} edge`] : []));
  const over = views.flatMap((view) => (sides(view).length > 0 ? [`${view.label} (${view.id}): ${sides(view).join(', ')}`] : []));
  return (
    `views overflow the drawing area at ${scaleText(scale)} — ${over.join('; ')}. ` +
    (fittingScale === scale ? 'use a larger paper' : `use scale ${scaleText(fittingScale)} (auto-fit) or a larger paper`)
  );
}

/** Cutting-plane line (with sight arrows and letters) of every section drawn from `parent`. */
function cuttingMarks(
  parent: Drawn,
  placed: PlacedView,
  map: (p: Vec2) => Vec2,
  sections: ReadonlyArray<DrawingView>,
  clearance: number,
): string[] {
  return sections.flatMap((section) => {
    const line = cuttingLine(parent.view, section);
    if (!line) return [];
    const { bounds } = parent.derived;
    const corners: Vec2[] = [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[1]],
      [bounds[0], bounds[3]],
      [bounds[2], bounds[3]],
    ];
    const along = corners.map((corner) => (corner[0] - line.point[0]) * line.along[0] + (corner[1] - line.point[1]) * line.along[1]);
    const reach = clearance / placed.perUnit;
    const ends = [Math.min(...along) - reach, Math.max(...along) + reach].map(
      (t): Vec2 => map([line.point[0] + line.along[0] * t, line.point[1] + line.along[1] * t]),
    );
    const sight: Vec2 = [line.sight[0], -line.sight[1]];
    const perpendicular: Vec2 = [-sight[1], sight[0]];
    const marks = ends.flatMap((end) => {
      const tip: Vec2 = [end[0] + sight[0] * 5, end[1] + sight[1] * 5];
      const arrow = [
        [end[0] + perpendicular[0] * 1.3, end[1] + perpendicular[1] * 1.3],
        [end[0] - perpendicular[0] * 1.3, end[1] - perpendicular[1] * 1.3],
        tip,
      ];
      return [
        `<polygon points="${arrow.map((point) => point.map(n).join(',')).join(' ')}" class="solid"/>`,
        svgText(end[0] + sight[0] * 8, end[1] + sight[1] * 8 + 1.2, 3.5, 'middle', section.mark ?? ''),
      ];
    });
    return [svgLine(ends[0] as Vec2, ends[1] as Vec2, 'plane'), ...marks];
  });
}

/** Circle and letter of every detail drawn from `parent`. */
function detailMarks(placed: PlacedView, map: (p: Vec2) => Vec2, details: ReadonlyArray<DrawingView>): string[] {
  return details.flatMap((detail) => {
    if (!detail.detail) return [];
    const [x, y] = map(detail.detail.center);
    const r = detail.detail.radius * placed.perUnit;
    return [
      `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" class="thin"/>`,
      svgText(x + r * 0.72, y - r * 0.72 - 1, 3.5, 'start', detail.mark ?? ''),
    ];
  });
}

const formatLength = (doc: CadDocument, value: number): string => String(Number(value.toFixed(Math.min(doc.displayPrecision, 4))));

/** Overall width and height dimensions of a projection view, below and to the right of its outline. */
function overallDimensions(doc: CadDocument, drawn: Drawn, map: (p: Vec2) => Vec2): string[] {
  const o = drawn.derived.outline;
  const [width, height] = [o[2] - o[0], o[3] - o[1]];
  return [
    ...(width > 0 ? paperDimension(map([o[0], o[1]]), map([o[2], o[1]]), -8, formatLength(doc, width)) : []),
    ...(height > 0 ? paperDimension(map([o[2], o[1]]), map([o[2], o[3]]), -8, formatLength(doc, height)) : []),
  ];
}

/**
 * @invariant deterministic: the same document and sheet always give the same SVG
 * @invariant views whose parent is missing or that draw nothing are listed in `skipped`, never thrown
 */
export function renderSheet(doc: CadDocument, sheet: DrawingSheet, options: { readonly showDimensions: boolean }): RenderedSheet {
  const skipped: Array<{ id: string; reason: string }> = [];
  const warnings: string[] = [];
  const drawn: Drawn[] = [];
  for (const view of sheet.views) {
    const derived = deriveView(doc, sheet, view);
    if (derived === null) skipped.push({ id: view.id, reason: 'parent view is missing or cannot be a detail parent' });
    else if (derived.primitives.length === 0 && view.kind !== 'detail')
      skipped.push({ id: view.id, reason: 'no 3D solids project into this view' });
    else {
      if (view.kind === 'detail' && derived.primitives.length === 0) warnings.push(`${view.id}: detail circle contains no geometry`);
      drawn.push({ view, derived });
    }
  }
  const area = sheetArea(sheet.paper);
  const items = drawn.map(({ view, derived }) => ({
    view,
    size: [derived.bounds[2] - derived.bounds[0], derived.bounds[3] - derived.bounds[1]] as Vec2,
  }));
  const layoutOptions = { angle: sheet.projectionAngle, area, mmPerUnit: MM_PER_UNIT[doc.units], margin: options.showDimensions ? 18 : 4 };
  const layout = layoutViews(items, { ...layoutOptions, scale: sheet.scale });
  const defs: string[] = [];
  const groups: string[] = [];
  const views: SheetViewInfo[] = [];
  const showsPmi = sheetShowsPmi(sheet);
  const pmiPlaced: SheetPmiReport['placed'] = [];
  const pmiReasons: Array<Map<string, PmiSkipReason>> = [];
  layout.placed.forEach((placed, index) => {
    const entry = drawn[index] as Drawn;
    const { view } = placed;
    const [mx, my] = center(entry.derived.bounds);
    const map = (point: Vec2): Vec2 => [
      placed.center[0] + (point[0] - mx) * placed.perUnit,
      placed.center[1] - (point[1] - my) * placed.perUnit,
    ];
    const painter = new DrawingPainter(map, placed.perUnit);
    entry.derived.primitives.forEach((primitive) => painter.paint(primitive));
    const own = view.scale !== undefined || view.kind === 'detail';
    const caption = own ? `${view.label} (${scaleText(placed.denominator)})` : view.label;
    const [x, y] = placed.center;
    const pmi = showsPmi ? paintViewPmi(doc, sheet, view, map) : null;
    if (pmi !== null) {
      pmiPlaced.push({ viewId: view.id, pmiIds: pmi.placedIds });
      pmiReasons.push(pmi.reasons);
    }
    const parts = [...painter.parts, ...(pmi?.parts ?? [])];
    const viewKey = escapeXml(view.id);
    const body = [`<g id="view-${viewKey}" data-kind="${view.kind}" data-label="${escapeXml(view.label)}">`];
    if (view.kind === 'detail') {
      const r = n(placed.width / 2);
      defs.push(`<clipPath id="clip-${viewKey}"><circle cx="${n(x)}" cy="${n(y)}" r="${r}"/></clipPath>`);
      body.push(`<g clip-path="url(#clip-${viewKey})">${parts.join('')}</g>`, `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" class="thin"/>`);
    } else {
      body.push(...parts);
      const hosted = sheet.views.filter((other) => other.section?.parentViewId === view.id);
      body.push(...cuttingMarks(entry, placed, map, hosted, options.showDimensions ? 14 : 6));
      body.push(
        ...detailMarks(
          placed,
          map,
          sheet.views.filter((other) => other.detail?.parentViewId === view.id),
        ),
      );
      if (options.showDimensions && view.kind === 'projection' && view.direction !== 'iso')
        body.push(...overallDimensions(doc, entry, map));
    }
    const labelY = y + placed.height / 2 + (options.showDimensions ? 22 : 8);
    body.push(svgText(x, labelY, 3.5, 'middle', caption), '</g>');
    groups.push(body.join(''));
    views.push({
      id: view.id,
      label: caption,
      kind: view.kind,
      scale: placed.denominator,
      scaleText: scaleText(placed.denominator),
      bounds: [round2(x - placed.width / 2), round2(y - placed.height / 2), round2(x + placed.width / 2), round2(y + placed.height / 2)],
    });
  });
  const fits = views.every(
    ({ bounds }) =>
      bounds[0] >= area.x - 0.01 &&
      bounds[1] >= area.y - 0.01 &&
      bounds[2] <= area.x + area.width + 0.01 &&
      bounds[3] <= area.y + area.height + 0.01,
  );
  if (!fits) warnings.push(overflowWarning(views, area, layout.scale, layoutViews(items, { ...layoutOptions, scale: undefined }).scale));
  const pmi = showsPmi ? { pmi: pmiReport(doc, sheet, pmiPlaced, pmiReasons) } : {};
  return {
    svg: composeSheet(sheet, layout.scale, groups.join('\n'), defs.join('')),
    scale: layout.scale,
    views,
    skipped,
    warnings,
    fits,
    ...pmi,
  };
}
