/**
 * The RGBA image of a decal for the viewport and the glTF export: its font mask in the decal colour over the background, or the built-in 5x7 block font for a decal without one.
 * Pure; both consumers share it so they show identical pixels.
 */

import type { Decal } from '../model/types';
import { base64ToUint8Array } from '../lib/base64';
import { rasterizeText } from '../lib/blockFont';
import { parseHexRgb } from '../lib/isHexColor';
import { unpackMask } from '../lib/outlineRaster';

export interface DecalImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly aspect: number;
}

export function decalImage(decal: Pick<Decal, 'text' | 'color' | 'background' | 'mask' | 'width' | 'height'>): DecalImage {
  const { mask } = decal;
  if (mask === undefined) return rasterizeText(decal.text, decal.color, decal.background);
  const coverage = unpackMask(base64ToUint8Array(mask.bits) ?? new Uint8Array(0), mask.width * mask.height);
  const ink = parseHexRgb(decal.color) ?? [255, 255, 255];
  const back = decal.background === undefined ? null : parseHexRgb(decal.background);
  const rgba = new Uint8Array(mask.width * mask.height * 4);
  coverage.forEach((on, k) => {
    if (on === 1) rgba.set([ink[0], ink[1], ink[2], 255], 4 * k);
    else if (back !== null) rgba.set([back[0], back[1], back[2], 255], 4 * k);
  });
  return { width: mask.width, height: mask.height, rgba, aspect: decal.width / decal.height };
}
