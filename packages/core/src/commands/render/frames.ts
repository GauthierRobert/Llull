/**
 * One camera rendered to an opaque PNG (walkthrough frames, BCF snapshots): the same scene, budget and raster as render_view (solids and
 * sketches; no grid, axes or captions), composited over a solid background. The pixel stage is the reference raster unless a host's
 * native raster is passed.
 * @pure (with the reference stage)
 */

import type { CadDocument, Vec3 } from '../../model/types';
import { encodePng } from '../../lib/png';
import { boundsCenter } from '../../geometry/bounds';
import { ORIGIN } from '../../lib/vec3';
import type { ViewpointCamera } from '../../model/review';
import { computeSceneSnapshot } from '../inspect/scene';
import { rasterScenePixels } from './raster';
import type { PixelStage } from './types';
import { renderDocument } from './scene';
import { viewpointView } from './viewSetup';

export const FRAME_BACKGROUND = '#1a1a2e';

/** `#rgb` / `#rrggbb` as [r, g, b], or null. */
export function hexRgb(color: string): [number, number, number] | null {
  const hex = color.trim().replace('#', '');
  const full = hex.length === 3 ? hex.replace(/(.)/g, '$1$1') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.substring(i, i + 2), 16)) as [number, number, number];
}

/** Centre of the scene bounds (the reach of a perspective camera's overlay scale). */
export function sceneCenter(doc: CadDocument): Vec3 {
  const bounds = computeSceneSnapshot(doc).bounds;
  return bounds ? boundsCenter(bounds) : ORIGIN;
}

/** PNG of `doc` seen by `camera`, `width` × `height`, over `background` (#rrggbb). */
export function renderCameraPng(
  doc: CadDocument,
  camera: ViewpointCamera,
  width: number,
  height: number,
  background: readonly [number, number, number],
  center: Vec3,
  pixels: PixelStage = rasterScenePixels,
): Uint8Array {
  let drawn: Uint8Array | null = null;
  const capture: PixelStage = (scene) => {
    drawn = pixels(scene);
    return new Uint8Array(drawn.length);
  };
  renderDocument(doc, 'custom', width, height, {
    view: viewpointView(camera, width, height, center),
    caption: false,
    background: null,
    pixels: capture,
  });
  const source: Uint8Array = drawn ?? new Uint8Array(width * height * 4);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const alpha = (source[i * 4 + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c += 1) out[i * 4 + c] = Math.round((source[i * 4 + c] ?? 0) * alpha + (background[c] ?? 0) * (1 - alpha));
    out[i * 4 + 3] = 255;
  }
  return encodePng(width, height, out, true);
}
