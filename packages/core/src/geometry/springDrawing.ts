/** SVG drawing of a spring between two screen points (render_motion): straight leads, a zig-zag coil between them, dots at the ends. */

export type ScreenPoint = readonly [number, number];

/** Fraction of the length that stays a straight lead at each end. */
const LEAD = 0.15;
const TEETH = 7;
const AMPLITUDE_PX = 5;
const COLOR = '#7cfc9a';

const r2 = (value: number): number => Math.round(value * 100) / 100;

/** Polyline points of the coil from `a` to `b` (a straight line when they are closer than 2 px). */
function coilPoints(a: ScreenPoint, b: ScreenPoint): ScreenPoint[] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy);
  if (length < 2) return [a, b];
  const [ux, uy] = [dx / length, dy / length];
  const at = (t: number, side: number): ScreenPoint => [a[0] + dx * t - uy * side * AMPLITUDE_PX, a[1] + dy * t + ux * side * AMPLITUDE_PX];
  const coil: ScreenPoint[] = [a, at(LEAD, 0)];
  for (let tooth = 0; tooth < TEETH; tooth++) coil.push(at(LEAD + ((1 - 2 * LEAD) * (tooth + 0.5)) / TEETH, tooth % 2 === 0 ? 1 : -1));
  coil.push(at(1 - LEAD, 0), b);
  return coil;
}

/** SVG elements of one spring between screen points `a` and `b`. */
export function springSvg(a: ScreenPoint, b: ScreenPoint): string {
  const points = coilPoints(a, b)
    .map((p) => `${r2(p[0])},${r2(p[1])}`)
    .join(' ');
  const dot = (p: ScreenPoint): string =>
    `<circle cx="${r2(p[0])}" cy="${r2(p[1])}" r="3" fill="${COLOR}" stroke="#101020" stroke-width="1"/>`;
  return `<polyline points="${points}" fill="none" stroke="${COLOR}" stroke-width="1.6" stroke-linejoin="round"/>${dot(a)}${dot(b)}`;
}
