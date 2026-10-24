/**
 * Even-odd scanline raster of closed polygons into a 1-bit coverage mask (03 WRP M4, font decals). A pixel is inked when its centre lies inside an odd number of polygons, so a
 * glyph with holes (O, B, 8) rasterises correctly from its loops. The mask is packed row-major from the top row, most significant bit first, with no row padding.
 */

export interface RasterBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

type Point = readonly [number, number];

/** Coverage (1 = ink) of `width` x `height` pixels over `box`; row 0 is the top (max y). */
export function rasterizePolygons(polygons: ReadonlyArray<readonly Point[]>, box: RasterBox, width: number, height: number): Uint8Array {
  const coverage = new Uint8Array(width * height);
  const pixelX = (box.maxX - box.minX) / width;
  const pixelY = (box.maxY - box.minY) / height;
  for (let row = 0; row < height; row++) {
    const y = box.maxY - (row + 0.5) * pixelY;
    const crossings: number[] = [];
    for (const polygon of polygons)
      for (let k = 0; k < polygon.length; k++) {
        const [a, b] = [polygon[k] as Point, polygon[(k + 1) % polygon.length] as Point];
        if (a[1] <= y === b[1] <= y) continue;
        crossings.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    crossings.sort((p, q) => p - q);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const first = Math.max(0, Math.ceil(((crossings[c] as number) - box.minX) / pixelX - 0.5));
      const last = Math.min(width - 1, Math.floor(((crossings[c + 1] as number) - box.minX) / pixelX - 0.5));
      for (let column = first; column <= last; column++) coverage[row * width + column] = 1;
    }
  }
  return coverage;
}

/** The coverage packed into bytes (8 pixels per byte, first pixel in the top bit). */
export function packMask(coverage: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(coverage.length / 8));
  coverage.forEach((value, k) => {
    if (value !== 0) bytes[k >> 3] = (bytes[k >> 3] as number) | (0x80 >> (k & 7));
  });
  return bytes;
}

/** The coverage of `count` pixels from packed bytes; missing bytes read as no ink. */
export function unpackMask(bytes: Uint8Array, count: number): Uint8Array {
  const coverage = new Uint8Array(count);
  for (let k = 0; k < count; k++) coverage[k] = ((bytes[k >> 3] ?? 0) >> (7 - (k & 7))) & 1;
  return coverage;
}
