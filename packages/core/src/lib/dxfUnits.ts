/**
 * DXF colour and unit tables: AutoCAD Color Index to hex, $INSUNITS to millimetres.
 * @layer core/lib
 * @pure
 */

const ACI_BASIC: Readonly<Record<number, string>> = {
  1: '#ff0000',
  2: '#ffff00',
  3: '#00ff00',
  4: '#00ffff',
  5: '#0000ff',
  6: '#ff00ff',
  7: '#000000',
  8: '#808080',
  9: '#c0c0c0',
};

/** Approximate hex colour of an AutoCAD Color Index (7 = black on a light background). */
export function aciToHex(aci: number): string {
  const basic = ACI_BASIC[aci];
  if (basic !== undefined) return basic;
  if (aci >= 250 && aci <= 255) {
    const level = Math.round(51 + ((aci - 250) * (255 - 51)) / 5);
    const hex = level.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
  }
  if (aci < 10 || aci > 249) return '#000000';
  const hue = (Math.floor((aci - 10) / 10) * 15) % 360;
  const shade = (aci - 10) % 10;
  const lightness = [0.5, 0.65, 0.4, 0.55, 0.3, 0.45, 0.2, 0.35, 0.15, 0.25][shade] ?? 0.5;
  const saturation = shade % 2 === 0 ? 1 : 0.5;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const channel = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Millimetres per drawing unit for a $INSUNITS code, or null when unitless / unknown. */
export function insUnitsMillimetres(code: number | null): number | null {
  switch (code) {
    case 1:
      return 25.4;
    case 2:
      return 304.8;
    case 4:
      return 1;
    case 5:
      return 10;
    case 6:
      return 1000;
    default:
      return null;
  }
}
