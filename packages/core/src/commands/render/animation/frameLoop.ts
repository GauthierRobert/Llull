/** Second pass of render_animation: every frame drawn through the fixed camera with its overlays, as an opaque RGBA turned into a PNG (and a sheet cell when asked). */

import type { ViewpointCamera } from '../../../model/review';
import { boundsCenter, type Bounds } from '../../../geometry/bounds';
import { encodePng } from '../../../lib/png';
import { makeProjector } from '../camera';
import { renderCameraRgba } from '../frames';
import { rasterScenePixels } from '../raster';
import { viewpointView } from '../viewSetup';
import type { PixelStage, SurfaceShading } from '../types';
import { appendOverlay } from './rasterOverlay';
import { frameOverlayOf } from './overlays';
import { cellSize, downscale, type SheetCell } from './sheet';
import type { ParsedFont } from '../../../lib/font/font';
import type { MotionFrames } from './types';

export interface FrameLoopInput {
  readonly motion: MotionFrames;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly camera: ViewpointCamera;
  readonly bounds: Bounds;
  readonly background: readonly [number, number, number];
  readonly pixels?: PixelStage | undefined;
  readonly shading?: ReadonlyMap<string, SurfaceShading> | undefined;
  readonly colorOverrides?: Readonly<Record<string, string>> | undefined;
  readonly font: ParsedFont | null;
  readonly time: boolean;
  /** Frame indices that also become sheet cells. */
  readonly sheetFrames: ReadonlySet<number>;
}

export interface FrameLoopOutput {
  readonly pngs: Uint8Array[];
  readonly cells: SheetCell[];
}

/** Draws every frame. @invariant the camera, the colours and the overlay layout are the same in every frame */
export function renderAllFrames(input: FrameLoopInput): FrameLoopOutput {
  const { width, height, camera, motion } = input;
  const view = viewpointView(camera, width, height, boundsCenter(input.bounds));
  const overlay = frameOverlayOf({
    width,
    height,
    project: makeProjector(view.camera, view.orthoHalf, width, height),
    font: input.font,
    traces: motion.traces,
    time: input.time,
  });
  const cell = cellSize(width, height);
  const pngs: Uint8Array[] = [];
  const cells: SheetCell[] = [];
  for (let k = 0; k < input.frames; k += 1) {
    const entry = motion.timeline[k];
    if (entry === undefined) break;
    const primitives = overlay(k, entry);
    const rgba = renderCameraRgba(
      motion.documentAt(k),
      camera,
      width,
      height,
      input.background,
      boundsCenter(input.bounds),
      input.pixels ?? rasterScenePixels,
      {
        augment: (scene) => appendOverlay(scene, primitives),
        ...(input.shading === undefined ? {} : { shading: input.shading }),
        ...(input.colorOverrides === undefined ? {} : { colorOverrides: input.colorOverrides }),
      },
    );
    pngs.push(encodePng(width, height, rgba, true));
    if (input.sheetFrames.has(k)) cells.push({ frame: k, tS: entry.tS, rgba: downscale(rgba, width, height, cell.width, cell.height) });
  }
  return { pngs, cells };
}
