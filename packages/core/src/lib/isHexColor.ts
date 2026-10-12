/** A `#rrggbb` hex color string (the only format the renderer accepts). */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** `[r, g, b]` (0..255) of a `#rrggbb` or `rrggbb` string (any case, trimmed), or null. */
export function parseHexRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (match === null) return null;
  return [
    parseInt(match[1] as string, 16),
    parseInt(match[2] as string, 16),
    parseInt(match[3] as string, 16),
  ];
}
