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

const sum = (values: ReadonlyArray<number>): number => values.reduce((total, value) => total + value + GAP, -GAP);

function arrange(auto: ReadonlyArray<Sized>, angle: ProjectionAngle): Arranged {
  const grid = new Map<string, Sized>();
  const extras: Sized[] = [];
  for (const sized of auto) {
    const direction = sized.item.view.kind === 'projection' ? sized.item.view.direction : undefined;
    const key = direction === undefined ? undefined : cellOf(direction, angle).join(',');
    if (key === undefined || grid.has(key)) extras.push(sized);
    else grid.set(key, sized);
  }
  const cells = [...grid.entries()].map(([key, sized]) => ({ sized, col: Number(key.split(',')[0]), row: Number(key.split(',')[1]) }));
  const gridKeys = new Set(grid.keys());
  const cols = [...new Set(cells.map((cell) => cell.col))].sort((a, b) => a - b);
  const rows = [...new Set(cells.map((cell) => cell.row))].sort((a, b) => a - b);
  const sizeOf = (
    indexes: number[],
    pick: (cell: (typeof cells)[number]) => number,
    of: (cell: (typeof cells)[number]) => number,
  ): number[] => indexes.map((index) => Math.max(...cells.filter((cell) => of(cell) === index).map(pick)));
  const colWidths = sizeOf(
    cols,
    (cell) => cell.sized.boxWidth,
    (cell) => cell.col,
  );
  const rowHeights = sizeOf(
    rows,
    (cell) => cell.sized.boxHeight,
    (cell) => cell.row,
  );
  const free = cols
    .flatMap((col, c) => rows.map((row, r) => ({ col, row, c, r })))
    .filter((slot) => !gridKeys.has(`${slot.col},${slot.row}`))
    .sort((a, b) => Math.abs(a.col) + Math.abs(a.row) - Math.abs(b.col) - Math.abs(b.row) || a.row - b.row || a.col - b.col);
  for (const sized of extras.filter((extra) => extra.item.view.kind !== 'projection')) {
    const index = free.findIndex(
      (slot) => sized.boxWidth <= (colWidths[slot.c] as number) && sized.boxHeight <= (rowHeights[slot.r] as number),
    );
    if (index < 0) continue;
    const [slot] = free.splice(index, 1);
    cells.push({ sized, col: (slot as { col: number }).col, row: (slot as { row: number }).row });
    extras.splice(extras.indexOf(sized), 1);
  }
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

/** Largest standard scale at which every auto-placed view fits `area`. */
function fitDenominator(items: ReadonlyArray<LayoutItem>, options: LayoutOptions): number {
  const auto = items.filter(isAuto);
  if (auto.length === 0) return 1;
  const fits = (candidate: number): { ok: boolean; ratio: number } => {
    const { width, height } = arrange(sizeViews(auto, candidate, options), options.angle);
    return {
      ok: width <= options.area.width && height <= options.area.height,
      ratio: Math.max(width / options.area.width, height / options.area.height),
    };
  };
  let last = 1;
  for (const candidate of STANDARD_SCALES) {
    const { ok, ratio } = fits(candidate);
    if (ok) return candidate;
    last = candidate * ratio;
  }
  let candidate = niceStep(last);
  for (let attempt = 0; attempt < 60 && !fits(candidate).ok; attempt++) candidate = niceStep(candidate * 1.01);
  return candidate;
}

/** Places `items` on the paper `area` (centred); views with a `position` keep it. @pure */
export function layoutViews(items: ReadonlyArray<LayoutItem>, options: LayoutOptions): Layout {
  const scale = options.scale ?? fitDenominator(items, options);
  const sized = sizeViews(items, scale, options);
  const { width, height, centers } = arrange(
    sized.filter((entry) => isAuto(entry.item)),
    options.angle,
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
