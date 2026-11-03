// Pure mapping of a P&ID sheet (plugin `pid`, glyphs from `buildPidDrawing`) to styled drawing primitives for DrawingPrimitives2D.

import { buildPidDrawing, PID_LAYERS, type PidDrawing, type PidGlyph, type PidModel, type PidSheet } from '@aec/index';
import type { Vec2 } from '@core/model/vectors';
import type { StyledPrimitive } from './drawingGeometry';
import { hitTestGlyphs } from './pidHitTest';

export interface PidPalette {
  readonly equipment: string;
  readonly pipe: string;
  readonly instrument: string;
  readonly signal: string;
  readonly text: string;
}

export const PID_PALETTE_DARK: PidPalette = {
  equipment: '#8fb8e8',
  pipe: '#d7dae0',
  instrument: '#7fd1a8',
  signal: '#d6a243',
  text: '#b9bec8',
};
export const PID_PALETTE_LIGHT: PidPalette = {
  equipment: '#1f5fa8',
  pipe: '#1f2125',
  instrument: '#1b7f55',
  signal: '#9a6a12',
  text: '#4a4f58',
};

/** Colour of the picked glyph. */
export const PID_HIGHLIGHT = { dark: '#ffb02e', light: '#d9480f' } as const;

const LAYER_KEY: Readonly<Record<string, keyof PidPalette>> = {
  [PID_LAYERS.equipment]: 'equipment',
  [PID_LAYERS.pipe]: 'pipe',
  [PID_LAYERS.instrument]: 'instrument',
  [PID_LAYERS.signal]: 'signal',
  [PID_LAYERS.text]: 'text',
};

/** The sheet drawn: `activeSheetId` while it exists, else the first in the model's own order (a deleted sheet falls back). */
export function activePidSheet(pid: PidModel | undefined, activeSheetId: string | null = null): PidSheet | undefined {
  if (pid === undefined) return undefined;
  const chosen = activeSheetId === null ? undefined : pid.sheets[activeSheetId];
  if (chosen !== undefined) return chosen;
  const id = pid.sheetOrder[0];
  return id === undefined ? undefined : pid.sheets[id];
}

let cached: { pid: PidModel; sheetId: string; drawing: PidDrawing } | undefined;

/** `buildPidDrawing` of a sheet, memoised on the model identity (the pick path asks at click time). */
function pidDrawingOf(pid: PidModel, sheet: PidSheet): PidDrawing {
  if (cached?.pid === pid && cached.sheetId === sheet.id) return cached.drawing;
  const drawing = buildPidDrawing(pid, sheet);
  cached = { pid, sheetId: sheet.id, drawing };
  return drawing;
}

/**
 * Styled primitives of the active sheet; layers hidden in the document (`layer-<name>`) are dropped. `only` keeps one glyph
 * and paints it in `only.color` (the highlight of the picked item).
 */
export function pidSheetItems(
  pid: PidModel | undefined,
  palette: PidPalette,
  isLayerVisible: (layer: string) => boolean = () => true,
  activeSheetId: string | null = null,
  only?: { readonly itemId: string; readonly color: string },
): StyledPrimitive[] {
  const sheet = activePidSheet(pid, activeSheetId);
  if (pid === undefined || sheet === undefined) return [];
  return pidDrawingOf(pid, sheet)
    .glyphs.filter((glyph) => only === undefined || glyph.id === only.itemId)
    .flatMap((glyph) =>
      glyph.primitives
        .filter((primitive) => isLayerVisible(primitive.layer))
        .map((primitive) => ({ primitive, color: only?.color ?? palette[LAYER_KEY[primitive.layer] ?? 'pipe'] })),
    );
}

/** The glyph of the active sheet under `point` (sheet units; `tolerance` in the same units), or null. */
export function pidGlyphAt(
  pid: PidModel | undefined,
  activeSheetId: string | null,
  point: Vec2,
  tolerance: number,
  isLayerVisible: (layer: string) => boolean,
): PidGlyph | null {
  const sheet = activePidSheet(pid, activeSheetId);
  if (pid === undefined || sheet === undefined) return null;
  return hitTestGlyphs(pidDrawingOf(pid, sheet).glyphs, point, tolerance, isLayerVisible);
}
