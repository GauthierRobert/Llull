// Pure: the line colour of a light / camera glyph. A pale light colour (warm white) vanishes on a light canvas, so the glyph keeps the
// hue but is pulled toward the ink of the theme (dark on a light background, light on a dark one).

const INK_SHARE = 0.55;

function channels(hex: string): [number, number, number] {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (value === undefined) return [128, 128, 128];
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/** Rec. 709 luma, 0..255. */
function luma([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function glyphInk(color: string, background: string): string {
  const ink = luma(channels(background)) > 140 ? 24 : 235;
  const mixed = channels(color).map((c) => Math.round(c * (1 - INK_SHARE) + ink * INK_SHARE));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
