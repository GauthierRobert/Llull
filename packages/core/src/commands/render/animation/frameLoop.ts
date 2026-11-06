/** Second pass of render_animation: every frame drawn through the fixed camera with its overlays, as an opaque RGBA turned into a PNG (and a sheet cell when asked). */

import type { ViewpointCamera } from '../../../model/review';
import { boundsCenter, type Bounds } from '../../../geometry/bounds';
import { encodePng } from '../../../lib/png';
import { renderCameraRgba } from '../frames';
import { rasterScenePixels } from '../raster';
import { viewpointView } from '../viewSetup';
import { viewProjector } from './viewProjector';
import type { PixelStage, SurfaceShading } from '../types';
import { appendOverlay } from './rasterOverlay';
import { frameOverlayOf, type FrameOverlay } from './overlays';
import { cellSize, downscale, type SheetCell } from './sheet';
import type { ParsedFont } from '../../../lib/font/font';
import type { MotionFrames } from './types';

export interface FrameLoopInput {
  readonly motion: MotionFrames;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  /** The camera of a frame. */
  readonly cameraAt: (frame: number) => ViewpointCamera;
  /** False: one camera for all frames, so the overlay layout is built once. */
  readonly cameraMoves: boolean;
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

/** Draws every frame. @invariant with a fixed camera the colours and the overlay layout are the same in every frame; the overlay is projected through the camera of its own frame */
export function renderAllFrames(input: FrameLoopInput): FrameLoopOutput {
  const { width, height, motion } = input;
  const centre = boundsCenter(input.bounds);
  const overlayOf = (camera: ViewpointCamera): FrameOverlay =>
    frameOverlayOf({
      width,
      height,
      project: viewProjector(viewpointView(camera, width, height, centre), width, height),
      font: input.font,
      traces: motion.traces,
      time: input.time,
    });
  let overlay = overlayOf(input.cameraAt(0));
  const cell = cellSize(width, height);
  const pngs: Uint8Array[] = [];
  const cells: SheetCell[] = [];
  for (let k = 0; k < input.frames; k += 1) {
    const entry = motion.timeline[k];
    if (entry === undefined) break;
    const camera = input.cameraAt(k);
    if (input.cameraMoves && k > 0) overlay = overlayOf(camera);
    const primitives = overlay(k, entry);
    const rgba = renderCameraRgba(
      motion.documentAt(k),
      camera,
      width,
      height,
      input.background,
      centre,
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
