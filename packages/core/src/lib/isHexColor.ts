/** A `#rrggbb` hex color string (the only format the renderer accepts). */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}
