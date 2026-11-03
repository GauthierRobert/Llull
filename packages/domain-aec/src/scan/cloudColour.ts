/** Point colours of render_view `clouds` (plant 10 SCN-M3c): viridis elevation, grey intensity, ASPRS classes, quantised stored rgb. Pure; same palettes as the viewport. */

const VIRIDIS: readonly (readonly [number, number, number])[] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

/** ASPRS standard classes (LAS 1.4 table 17); any other code is mid grey. */
const ASPRS: Readonly<Record<number, string>> = {
  0: '#9a9a9a',
  1: '#b0b0b0',
  2: '#a0713c',
  3: '#8fd16b',
  4: '#4fae4f',
  5: '#1e7a2e',
  6: '#e0584a',
  7: '#e8d34a',
  8: '#f0f0f0',
  9: '#3c7fe0',
  10: '#6a4a3a',
  11: '#505050',
  12: '#c0c0c0',
  13: '#ffb347',
  14: '#ff8c1a',
  15: '#7a5cc0',
  16: '#9c6bd0',
  17: '#2a6f97',
  18: '#d94f9e',
};

const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Quantisation steps of the continuous ramps: one SVG path per colour, so the picture stays small. */
const STEPS = 32;

const quantised = (t: number): number => Math.round(Math.min(1, Math.max(0, t)) * (STEPS - 1)) / (STEPS - 1);

/** viridis at `t` in [0, 1], quantised to 32 steps. */
export function viridis(t: number): string {
  const scaled = quantised(t) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = VIRIDIS[i] ?? [0, 0, 0];
  const b = VIRIDIS[i + 1] ?? [0, 0, 0];
  return hex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

/** Grey at `t` in [0, 1] (dark to light, never fully black), quantised to 32 steps. */
export function grey(t: number): string {
  const v = 40 + quantised(t) * 200;
  return hex(v, v, v);
}

export const classColour = (code: number): string => ASPRS[code] ?? '#7a7a7a';

/** Stored rgb (0-255 per channel) reduced to 4 bits per channel (4096 colours at most). */
export const rgbColour = (r: number, g: number, b: number): string => hex((r >> 4) * 17, (g >> 4) * 17, (b >> 4) * 17);
