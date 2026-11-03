// Pure mapping of a P&ID sheet (plugin `pid`, glyphs from `buildPidDrawing`) to styled drawing primitives for DrawingPrimitives2D.

import { buildPidDrawing, PID_LAYERS, type PidModel, type PidSheet } from '@aec/index';
import type { StyledPrimitive } from './drawingGeometry';

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

const LAYER_KEY: Readonly<Record<string, keyof PidPalette>> = {
  [PID_LAYERS.equipment]: 'equipment',
  [PID_LAYERS.pipe]: 'pipe',
  [PID_LAYERS.instrument]: 'instrument',
  [PID_LAYERS.signal]: 'signal',
  [PID_LAYERS.text]: 'text',
};

/** The sheet drawn by default: the first in the model's own order. */
export function defaultPidSheet(pid: PidModel | undefined): PidSheet | undefined {
  const id = pid?.sheetOrder[0];
  return pid === undefined || id === undefined ? undefined : pid.sheets[id];
}

/** Styled primitives of the default sheet; layers hidden in the document (`layer-<name>`) are dropped. */
export function pidSheetItems(
  pid: PidModel | undefined,
  palette: PidPalette,
  isLayerVisible: (layer: string) => boolean = () => true,
): StyledPrimitive[] {
  const sheet = defaultPidSheet(pid);
  if (pid === undefined || sheet === undefined) return [];
  return buildPidDrawing(pid, sheet).glyphs.flatMap((glyph) =>
    glyph.primitives
      .filter((primitive) => isLayerVisible(primitive.layer))
      .map((primitive) => ({ primitive, color: palette[LAYER_KEY[primitive.layer] ?? 'pipe'] })),
  );
}
