// Pure helpers of the sheet viewer: typed reading of `export_sheet_svg` data, view hit-testing, pan/zoom/fit math.

import { isRecord } from '@lib/isRecord';

export interface SheetViewInfo {
  id: string;
  label: string;
  kind: string;
  scaleText: string;
  /** [minX, minY, maxX, maxY] in paper millimetres, origin top-left. */
  bounds: readonly [number, number, number, number];
}

export interface SheetExport {
  svg: string;
  paper: string;
  scaleText: string;
  widthMm: number;
  heightMm: number;
  fits: boolean;
  views: SheetViewInfo[];
  skipped: Array<{ id: string; reason: string }>;
  warnings: string[];
}

function readView(value: unknown): SheetViewInfo | null {
  if (!isRecord(value)) return null;
  const { id, label, kind, scaleText, bounds } = value;
  if (typeof id !== 'string' || typeof label !== 'string' || typeof kind !== 'string') return null;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((n) => typeof n === 'number')) return null;
  const [minX = 0, minY = 0, maxX = 0, maxY = 0] = bounds as number[];
  return { id, label, kind, scaleText: typeof scaleText === 'string' ? scaleText : '', bounds: [minX, minY, maxX, maxY] };
}

/** null when `data` is not an `export_sheet_svg` payload (unknown sheet). */
export function readSheetExport(data: unknown): SheetExport | null {
  if (!isRecord(data)) return null;
  const { svg, paper, scaleText, widthMm, heightMm, fits, views, skipped, warnings } = data;
  if (typeof svg !== 'string' || typeof widthMm !== 'number' || typeof heightMm !== 'number') return null;
  return {
    svg,
    paper: typeof paper === 'string' ? paper : '',
    scaleText: typeof scaleText === 'string' ? scaleText : '',
    widthMm,
    heightMm,
    fits: fits !== false,
    views: Array.isArray(views) ? views.flatMap((view) => readView(view) ?? []) : [],
    skipped: Array.isArray(skipped)
      ? skipped.flatMap((entry) =>
          isRecord(entry) && typeof entry['id'] === 'string' ? [{ id: entry['id'], reason: String(entry['reason'] ?? '') }] : [],
        )
      : [],
    warnings: Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string' && warning !== '') : [],
  };
}

/** Id of the smallest view whose bounds contain the paper point (a detail drawn over its parent wins). */
export function viewAtPaperPoint(views: readonly SheetViewInfo[], x: number, y: number): string | null {
  let best: SheetViewInfo | null = null;
  let bestArea = Infinity;
  for (const view of views) {
    const [minX, minY, maxX, maxY] = view.bounds;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const area = (maxX - minX) * (maxY - minY);
    if (area < bestArea) {
      best = view;
      bestArea = area;
    }
  }
  return best?.id ?? null;
}

/** Screen placement of the paper: top-left offset in px and px per millimetre. */
export interface PaperTransform {
  x: number;
  y: number;
  k: number;
}

const FIT_MARGIN_PX = 32;
const MIN_K = 0.05;
const MAX_K = 40;

export function fitTransform(viewportW: number, viewportH: number, paperW: number, paperH: number): PaperTransform {
  const k = Math.min(
    Math.max((viewportW - 2 * FIT_MARGIN_PX) / paperW, MIN_K),
    Math.max((viewportH - 2 * FIT_MARGIN_PX) / paperH, MIN_K),
    MAX_K,
  );
  return { k, x: (viewportW - paperW * k) / 2, y: (viewportH - paperH * k) / 2 };
}

/** Zooms by `factor` keeping the paper point under the screen point (px relative to the viewport) fixed. */
export function zoomAt(transform: PaperTransform, factor: number, pointX: number, pointY: number): PaperTransform {
  const k = Math.min(Math.max(transform.k * factor, MIN_K), MAX_K);
  const ratio = k / transform.k;
  return { k, x: pointX - (pointX - transform.x) * ratio, y: pointY - (pointY - transform.y) * ratio };
}

export function screenToPaper(transform: PaperTransform, pointX: number, pointY: number): [number, number] {
  return [(pointX - transform.x) / transform.k, (pointY - transform.y) / transform.k];
}
