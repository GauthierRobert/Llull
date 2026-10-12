import type { ImageEntity } from '../../model/types';
import { pixelToWorld } from '../../geometry/imageUnderlay';
import type { Projector } from './camera';

/** 6 decimals: the per-pixel matrix terms of a large scan are tiny. */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * `<image>` of an underlay, mapped onto the screen by one affine `matrix(...)`: an orthographic
 * projection of a planar image is affine, so its pixel axes project to the matrix columns.
 * @pure
 */
export function underlaySvg(image: ImageEntity, project: Projector): string {
  const { pixelWidth, pixelHeight } = image;
  const [ox, oy] = project(pixelToWorld(image, [0, 0]));
  const [xx, xy] = project(pixelToWorld(image, [pixelWidth, 0]));
  const [yx, yy] = project(pixelToWorld(image, [0, pixelHeight]));
  const matrix = [
    (xx - ox) / pixelWidth,
    (xy - oy) / pixelWidth,
    (yx - ox) / pixelHeight,
    (yy - oy) / pixelHeight,
    ox,
    oy,
  ].map(r6);
  return (
    `  <image data-id="${image.id}" href="${image.dataUrl}" x="0" y="0" width="${pixelWidth}" ` +
    `height="${pixelHeight}" preserveAspectRatio="none" opacity="${image.opacity}" ` +
    `transform="matrix(${matrix.join(' ')})"/>`
  );
}
