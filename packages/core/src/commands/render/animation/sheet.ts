/** The contact sheet of render_animation (TR-MOV-16): every n-th frame and the last one, scaled to at most 320 px wide cells, labelled `#k t = … s`, one PNG. */

import type { ParsedFont } from '../../../lib/font/font';
import { clamp } from '../../../lib/clamp';
import { encodePng } from '../../../lib/png';
import { rasterScenePixels } from '../raster';
import { appendOverlay, emptyScene, OVERLAY_Z, type OverlayFill, type OverlayStroke } from './rasterOverlay';
import { placeText } from './overlayText';

const MAX_CELL_WIDTH = 320;
const MAX_COLUMNS = 6;
const BACKGROUND = [11, 11, 22] as const;
const INK = [232, 232, 244] as const;

/** Frame indices of the sheet: 0, every, 2·every, … and always the last frame. */
export function sheetFrames(frames: number, every: number): number[] {
  const picked: number[] = [];
  for (let k = 0; k < frames; k += every) picked.push(k);
  if (picked[picked.length - 1] !== frames - 1) picked.push(frames - 1);
  return picked;
}

/** Cell size for frames of `width` × `height`. */
export function cellSize(width: number, height: number): { width: number; height: number } {
  const cellWidth = Math.min(MAX_CELL_WIDTH, width);
  return { width: cellWidth, height: Math.max(1, Math.round((height * cellWidth) / width)) };
}

/** Box-filter (area average) reduction of an opaque RGBA image to `toWidth` × `toHeight`. */
export function downscale(rgba: Uint8Array, width: number, height: number, toWidth: number, toHeight: number): Uint8Array {
  const out = new Uint8Array(toWidth * toHeight * 4);
  for (let y = 0; y < toHeight; y += 1) {
    const [y0, y1] = [
      Math.floor((y * height) / toHeight),
      Math.max(Math.floor((y * height) / toHeight) + 1, Math.ceil(((y + 1) * height) / toHeight)),
    ];
    for (let x = 0; x < toWidth; x += 1) {
      const [x0, x1] = [
        Math.floor((x * width) / toWidth),
        Math.max(Math.floor((x * width) / toWidth) + 1, Math.ceil(((x + 1) * width) / toWidth)),
      ];
      const sum = [0, 0, 0];
      let count = 0;
      for (let sy = y0; sy < Math.min(y1, height); sy += 1)
        for (let sx = x0; sx < Math.min(x1, width); sx += 1) {
          for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + (rgba[(sy * width + sx) * 4 + c] ?? 0);
          count += 1;
        }
      const at = (y * toWidth + x) * 4;
      for (let c = 0; c < 3; c += 1) out[at + c] = Math.round((sum[c] ?? 0) / Math.max(count, 1));
      out[at + 3] = 255;
    }
  }
  return out;
}

export interface SheetCell {
  readonly frame: number;
  readonly tS: number;
  /** The frame reduced to `cellSize`. */
  readonly rgba: Uint8Array;
}

export interface Sheet {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
}

/** The sheet PNG of `cells` (frames reduced to `cell`); labels are drawn when a `font` is given. */
export function buildSheet(cells: readonly SheetCell[], cell: { width: number; height: number }, font: ParsedFont | null): Sheet {
  const columns = Math.min(MAX_COLUMNS, cells.length);
  const rows = Math.ceil(cells.length / columns);
  const cap = clamp(Math.round(cell.width / 24), 8, 14);
  const labelHeight = cap * 2;
  const pitchY = cell.height + labelHeight;
  const width = columns * cell.width;
  const height = rows * pitchY;
  const canvas = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) canvas.set([BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 255], i * 4);
  const fills: OverlayFill[] = [];
  const strokes: OverlayStroke[] = [];
  cells.forEach((item, index) => {
    const [left, top] = [(index % columns) * cell.width, Math.floor(index / columns) * pitchY];
    for (let y = 0; y < cell.height; y += 1) {
      const from = y * cell.width * 4;
      canvas.set(item.rgba.subarray(from, from + cell.width * 4), ((top + labelHeight + y) * width + left) * 4);
    }
    if (font === null) return;
    const text = placeText(
      font,
      `#${item.frame} t = ${+item.tS.toFixed(5)} s`,
      cap,
      left + 4,
      top + cap + cap / 2,
      'left',
      INK,
      OVERLAY_Z.text,
    );
    fills.push(...text.fills);
    strokes.push(...text.strokes);
  });
  if (fills.length + strokes.length > 0) {
    const ink = rasterScenePixels(appendOverlay(emptyScene(width, height), { fills, strokes }));
    for (let i = 0; i < width * height; i += 1) {
      const alpha = (ink[i * 4 + 3] ?? 0) / 255;
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c += 1) canvas[i * 4 + c] = Math.round((ink[i * 4 + c] ?? 0) * alpha + (canvas[i * 4 + c] ?? 0) * (1 - alpha));
    }
  }
  return { png: encodePng(width, height, canvas, true), width, height, columns };
}
