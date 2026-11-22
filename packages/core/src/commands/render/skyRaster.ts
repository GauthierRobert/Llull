/**
 * Sky behind a raster (plant 09 VIS-M8): the pixels no face covers show the Preetham / Sky.js sky of the site's sun (`@lib/preethamSky`) per
 * pixel view direction. An orthographic view has one direction, so its sky is one flat colour. Applied after the pixel stage (reference or
 * native), so both stages share it.
 * @pure
 */

import type { Vec3 } from '../../model/types';
import { cross3, normalize3 } from '../../lib/vec3';
import { skyRadiance, skyRgb, skyState } from '../../lib/preethamSky';
import { type Camera, type SkyLight, cameraBasis } from './camera';

/** RGB (`width` × `height` × 3) of the sky seen by `cam` (perspective when `cam.fovDeg` is set). */
export function skyBackdrop(sky: SkyLight, cam: Camera, width: number, height: number): Uint8Array {
  const state = skyState(sky.sunDirection);
  const out = new Uint8Array(width * height * 3);
  const basis = cameraBasis(cam);
  if (cam.fovDeg === undefined) {
    const [r, g, b] = skyRgb(skyRadiance(state, basis.fwd));
    for (let i = 0; i < width * height; i += 1) out.set([r, g, b], i * 3);
    return out;
  }
  const focal = height / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  const right = normalize3(cross3(basis.fwd, cam.up));
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const u = x + 0.5 - width / 2;
      const v = height / 2 - (y + 0.5);
      const d: Vec3 = [
        basis.fwd[0] * focal + right[0] * u + basis.up[0] * v,
        basis.fwd[1] * focal + right[1] * u + basis.up[1] * v,
        basis.fwd[2] * focal + right[2] * u + basis.up[2] * v,
      ];
      out.set(skyRgb(skyRadiance(state, normalize3(d))), (y * width + x) * 3);
    }
  return out;
}

/** `rgba` (straight alpha) composited over `backdrop` (RGB): an opaque RGBA of the same size. */
export function overBackdrop(rgba: Uint8Array, backdrop: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length / 4; i += 1) {
    const alpha = (rgba[i * 4 + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c += 1) out[i * 4 + c] = Math.round((rgba[i * 4 + c] ?? 0) * alpha + (backdrop[i * 3 + c] ?? 0) * (1 - alpha));
    out[i * 4 + 3] = 255;
  }
  return out;
}
