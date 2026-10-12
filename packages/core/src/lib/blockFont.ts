/**
 * Built-in 5×7 block font and a text rasterizer (RGBA, transparent or solid background), used for
 * text decals so the viewport and the glTF export show identical pixels without a font engine.
 * Lower-case letters render as capitals; unknown characters render as a blank.
 *
 * @layer lib
 * @pure
 */

/** Seven rows of five bits (MSB = left column) per glyph. */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  ',': [0, 0, 0, 0, 12, 4, 8],
  ':': [0, 12, 12, 0, 12, 12, 0],
  '/': [1, 1, 2, 4, 8, 16, 16],
  '+': [0, 4, 4, 31, 4, 4, 0],
  '&': [12, 18, 20, 8, 21, 18, 13],
  '!': [4, 4, 4, 4, 4, 0, 4],
  '?': [14, 17, 1, 2, 4, 0, 4],
  "'": [4, 4, 8, 0, 0, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

/** Pixels per font dot in rasterized text. */
const DOT = 6;
/** Glyph cell: 5 dots + 1 dot spacing wide, 7 dots + 2 dots margin high. */
const CELL_W = 6;
const CELL_H = 9;

/** Whether `ch` has a glyph (after upper-casing). */
export function hasGlyph(ch: string): boolean {
  return GLYPHS[ch.toUpperCase()] !== undefined;
}

type Rgba = readonly [number, number, number, number];

function hexRgba(hex: string | undefined, alpha: number): Rgba {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex ?? '').trim());
  if (match === null) return [0, 0, 0, 0];
  return [
    parseInt(match[1] as string, 16),
    parseInt(match[2] as string, 16),
    parseInt(match[3] as string, 16),
    alpha,
  ];
}

/**
 * RGBA image of one line of `text` in `color` over `background` (transparent when absent).
 * Width/height are powers of two so the texture mipmaps; `aspect` is the inked width / height.
 */
export function rasterizeText(
  text: string,
  color: string,
  background?: string,
): { width: number; height: number; rgba: Uint8Array; aspect: number } {
  const chars = [...text.toUpperCase()];
  const inkW = Math.max(1, chars.length * CELL_W + 1) * DOT;
  const inkH = CELL_H * DOT;
  const width = 2 ** Math.ceil(Math.log2(inkW));
  const height = 2 ** Math.ceil(Math.log2(inkH));
  const rgba = new Uint8Array(width * height * 4);
  const fill = hexRgba(color, 255);
  const back = hexRgba(background, background === undefined ? 0 : 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Stretch the inked area over the whole power-of-two image.
      const ix = Math.floor(((x / width) * inkW) / DOT);
      const iy = Math.floor(((y / height) * inkH) / DOT);
      const glyph = GLYPHS[chars[Math.floor((ix - 1) / CELL_W)] ?? ' '];
      const col = (ix - 1) % CELL_W;
      const row = iy - 1;
      const on =
        glyph !== undefined &&
        ix >= 1 &&
        col < 5 &&
        row >= 0 &&
        row < 7 &&
        (((glyph[row] as number) >> (4 - col)) & 1) === 1;
      rgba.set(on ? fill : back, (y * width + x) * 4);
    }
  }
  return { width, height, rgba, aspect: inkW / inkH };
}
