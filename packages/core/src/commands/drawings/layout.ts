/** Deterministic sheet layout: projection views on the first/third-angle grid around the front view, the rest in a row below; auto scale. */

import type { Vec2 } from '../../model/vectors';
import type { DrawingView, ProjectionAngle, ViewDirection } from '../../model/sheet';
import { niceStep } from '../../lib/niceStep';

export interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A view to place: the size of its geometry in model units. */
export interface LayoutItem {
  readonly view: DrawingView;
  readonly size: Vec2;
}

export interface PlacedView {
  readonly view: DrawingView;
  /** Paper mm centre of the view's geometry box. */
  readonly center: Vec2;
  /** Paper mm size of the geometry box. */
  readonly width: number;
  readonly height: number;
  /** Denominator N of this view's own scale. */
  readonly denominator: number;
  /** Paper mm per model unit. */
  readonly perUnit: number;
}

export interface Layout {
  /** Sheet scale denominator N (given, or the largest standard scale that fits). */
  readonly scale: number;
  readonly placed: PlacedView[];
}

interface LayoutOptions {
  readonly angle: ProjectionAngle;
  readonly area: Area;
  readonly mmPerUnit: number;
  /** Sheet scale; absent = auto-fit. */
  readonly scale: number | undefined;
  /** Clear paper mm around each view geometry (room for dimensions). */
  readonly margin: number;
}

/** Enlargements (10:1 … 2:1) then reductions; the first that fits wins. */
const STANDARD_SCALES: ReadonlyArray<number> = [0.1, 0.2, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

/** Scales a detail's default magnification is taken from: the sheet scales without 1:2.5. */
const DETAIL_SCALES: ReadonlyArray<number> = STANDARD_SCALES.filter((candidate) => candidate !== 2.5);

/** Paper mm reserved under a view for its label; paper mm between neighbouring views. */
const LABEL_HEIGHT = 8;
const GAP = 8;

/** Grid cell (column, row) of a standard view; the front view is the anchor at (0, 0). Rows grow downward on paper. */
function cellOf(direction: ViewDirection, angle: ProjectionAngle): readonly [number, number] {
  const first = angle === 'first';
  switch (direction) {
    case 'front':
      return [0, 0];
    case 'top':
      return [0, first ? 1 : -1];
    case 'bottom':
      return [0, first ? -1 : 1];
    case 'right':
      return [first ? -1 : 1, 0];
    case 'left':
      return [first ? 1 : -1, 0];
    case 'back':
      return [2, 0];
    case 'iso':
      return [1, first ? 1 : -1];
  }
}

/** Own scale of a view at sheet scale `scale`: explicit, else a detail is a 2x magnification, else the sheet scale. */
export const viewDenominator = (view: DrawingView, scale: number): number =>
  view.scale ?? (view.kind === 'detail' ? magnified(scale) : scale);

/** The standard scale at least 2x larger than `scale` (the largest standard denominator <= scale / 2). */
const magnified = (scale: number): number =>
  [...DETAIL_SCALES].reverse().find((candidate) => candidate <= scale / 2) ?? (DETAIL_SCALES[0] as number);

interface Sized {
  readonly item: LayoutItem;
  readonly denominator: number;
  readonly perUnit: number;
  readonly width: number;
  readonly height: number;
  readonly boxWidth: number;
  readonly boxHeight: number;
}

interface Arranged {
  readonly width: number;
  readonly height: number;
  /** Per auto-placed view: box centre relative to the arrangement's top-left. */
  readonly centers: Map<Sized, Vec2>;
}

interface Cell {
  readonly sized: Sized;
  readonly col: number;
  readonly row: number;
}

interface ArrangeOptions {
  readonly angle: ProjectionAngle;
  /** Paper space available: a view is only placed beside its parent (new column) when the result still fits. */
  readonly limit?: { readonly width: number; readonly height: number };
  /** The isometric view is placed like a section (any free slot, else beside the front row) instead of owning a grid cell. */
  readonly floatingIso?: boolean;
}

const sum = (values: ReadonlyArray<number>): number => values.reduce((total, value) => total + value + GAP, -GAP);

/** Sorted distinct column / row indexes of `cells` and the size (max box) of each. */
function measure(cells: ReadonlyArray<Cell>): { cols: number[]; rows: number[]; colWidths: number[]; rowHeights: number[] } {
  const cols = [...new Set(cells.map((cell) => cell.col))].sort((a, b) => a - b);
  const rows = [...new Set(cells.map((cell) => cell.row))].sort((a, b) => a - b);
  const colWidths = cols.map((col) => Math.max(...cells.filter((cell) => cell.col === col).map((cell) => cell.sized.boxWidth)));
  const rowHeights = rows.map((row) => Math.max(...cells.filter((cell) => cell.row === row).map((cell) => cell.sized.boxHeight)));
  return { cols, rows, colWidths, rowHeights };
}

const fitsLimit = (cells: ReadonlyArray<Cell>, limit: ArrangeOptions['limit']): boolean => {
  if (!limit) return true;
  const { colWidths, rowHeights } = measure(cells);
  return sum(colWidths) <= limit.width && sum(rowHeights) <= limit.height;
};

function arrange(auto: ReadonlyArray<Sized>, { angle, limit, floatingIso = false }: ArrangeOptions): Arranged {
  const grid = new Map<string, Sized>();
  const extras: Sized[] = [];
  for (const sized of auto) {
    const { view } = sized.item;
    const direction = view.kind === 'projection' && !(floatingIso && view.direction === 'iso') ? view.direction : undefined;
    const key = direction === undefined ? undefined : cellOf(direction, angle).join(',');
    if (key === undefined || grid.has(key)) extras.push(sized);
    else grid.set(key, sized);
  }
  const cells: Cell[] = [...grid.entries()].map(([key, sized]) => ({
    sized,
    col: Number(key.split(',')[0]),
    row: Number(key.split(',')[1]),
  }));
  const gridKeys = new Set(grid.keys());
  const initial = measure(cells);
  const free = initial.cols
    .flatMap((col, c) => initial.rows.map((row, r) => ({ col, row, c, r })))
    .filter((slot) => !gridKeys.has(`${slot.col},${slot.row}`))
    .sort((a, b) => Math.abs(a.col) + Math.abs(a.row) - Math.abs(b.col) - Math.abs(b.row) || a.row - b.row || a.col - b.col);
  const placeable = (extra: Sized): boolean =>
    extra.item.view.kind !== 'projection' || (floatingIso && extra.item.view.direction === 'iso');
  for (const sized of extras.filter(placeable)) {
    const index = free.findIndex(
      (slot) => sized.boxWidth <= (initial.colWidths[slot.c] as number) && sized.boxHeight <= (initial.rowHeights[slot.r] as number),
    );
    if (index >= 0) {
      const [slot] = free.splice(index, 1);
      cells.push({ sized, col: (slot as { col: number }).col, row: (slot as { row: number }).row });
      extras.splice(extras.indexOf(sized), 1);
      continue;
    }
    const parentId = sized.item.view.section?.parentViewId ?? sized.item.view.detail?.parentViewId;
    const parentRow = cells.find((cell) => cell.sized.item.view.id === parentId)?.row ?? 0;
    const beside: Cell = { sized, col: Math.max(-1, ...cells.map((cell) => cell.col)) + 1, row: cells.length > 0 ? parentRow : 0 };
    if (cells.length === 0 || !fitsLimit([...cells, beside], limit)) continue;
    cells.push(beside);
    extras.splice(extras.indexOf(sized), 1);
  }
  const { cols, rows, colWidths, rowHeights } = measure(cells);
  const gridWidth = cells.length > 0 ? sum(colWidths) : 0;
  const gridHeight = cells.length > 0 ? sum(rowHeights) : 0;
  const extrasWidth = extras.length > 0 ? sum(extras.map((sized) => sized.boxWidth)) : 0;
  const extrasHeight = Math.max(0, ...extras.map((sized) => sized.boxHeight));
  const width = Math.max(gridWidth, extrasWidth);
  const height = gridHeight + (cells.length > 0 && extras.length > 0 ? GAP : 0) + extrasHeight;
  const centers = new Map<Sized, Vec2>();
  const offset = (sizes: number[], index: number): number => sizes.slice(0, index).reduce((total, size) => total + size + GAP, 0);
  for (const { sized, col, row } of cells) {
    const [c, r] = [cols.indexOf(col), rows.indexOf(row)];
    const x = (width - gridWidth) / 2 + offset(colWidths, c) + (colWidths[c] as number) / 2;
    centers.set(sized, [x, offset(rowHeights, r) + (rowHeights[r] as number) / 2]);
  }
  let cursor = (width - extrasWidth) / 2;
  for (const sized of extras) {
    centers.set(sized, [cursor + sized.boxWidth / 2, height - extrasHeight / 2]);
    cursor += sized.boxWidth + GAP;
  }
  return { width, height, centers };
}

const sizeViews = (items: ReadonlyArray<LayoutItem>, scale: number, { mmPerUnit, margin }: LayoutOptions): Sized[] =>
  items.map((item) => {
    const denominator = viewDenominator(item.view, scale);
    const perUnit = mmPerUnit / denominator;
    const [width, height] = [item.size[0] * perUnit, item.size[1] * perUnit];
    return { item, denominator, perUnit, width, height, boxWidth: width + 2 * margin, boxHeight: height + 2 * margin + LABEL_HEIGHT };
  });

const isAuto = (item: LayoutItem): boolean => item.view.position === undefined;

interface Fit {
  readonly denominator: number;
  readonly floatingIso: boolean;
}

const arrangeOptions = (options: LayoutOptions, floatingIso: boolean): ArrangeOptions => ({
  angle: options.angle,
  limit: { width: options.area.width, height: options.area.height },
  floatingIso,
});

/** A given scale: the isometric view floats only when the grid overflows and floating fits. */
function fixedFit(items: ReadonlyArray<LayoutItem>, scale: number, options: LayoutOptions): Fit {
  const auto = items.filter(isAuto);
  const overflows = (floatingIso: boolean): boolean => {
    const { width, height } = arrange(sizeViews(auto, scale, options), arrangeOptions(options, floatingIso));
    return width > options.area.width || height > options.area.height;
  };
  return { denominator: scale, floatingIso: auto.length > 0 && overflows(false) && !overflows(true) };
}

/** Largest standard scale at which every auto-placed view fits `area`; the isometric view may float to make a larger scale fit. */
function fitDenominator(items: ReadonlyArray<LayoutItem>, options: LayoutOptions): Fit {
  const auto = items.filter(isAuto);
  if (auto.length === 0) return { denominator: 1, floatingIso: false };
  const fits = (candidate: number, floatingIso: boolean): { ok: boolean; ratio: number } => {
    const { width, height } = arrange(sizeViews(auto, candidate, options), arrangeOptions(options, floatingIso));
    return {
      ok: width <= options.area.width && height <= options.area.height,
      ratio: Math.max(width / options.area.width, height / options.area.height),
    };
  };
  let last = 1;
  for (const candidate of STANDARD_SCALES) {
    const { ok, ratio } = fits(candidate, false);
    if (ok) return { denominator: candidate, floatingIso: false };
    if (fits(candidate, true).ok) return { denominator: candidate, floatingIso: true };
    last = candidate * ratio;
  }
  let candidate = niceStep(last);
  for (let attempt = 0; attempt < 60 && !fits(candidate, false).ok; attempt++) candidate = niceStep(candidate * 1.01);
  return { denominator: candidate, floatingIso: false };
}

/** Places `items` on the paper `area` (centred); views with a `position` keep it. @pure */
export function layoutViews(items: ReadonlyArray<LayoutItem>, options: LayoutOptions): Layout {
  const fit = options.scale === undefined ? fitDenominator(items, options) : fixedFit(items, options.scale, options);
  const scale = fit.denominator;
  const sized = sizeViews(items, scale, options);
  const { width, height, centers } = arrange(
    sized.filter((entry) => isAuto(entry.item)),
    arrangeOptions(options, fit.floatingIso),
  );
  const [x0, y0] = [options.area.x + (options.area.width - width) / 2, options.area.y + (options.area.height - height) / 2];
  const placed = sized.map((entry): PlacedView => {
    const fixed = entry.item.view.position;
    const box = centers.get(entry);
    const center: Vec2 = fixed ?? (box ? [x0 + box[0], y0 + box[1] - LABEL_HEIGHT / 2] : [0, 0]);
    const { view } = entry.item;
    return { view, center, width: entry.width, height: entry.height, denominator: entry.denominator, perUnit: entry.perUnit };
  });
  return { scale, placed };
}
