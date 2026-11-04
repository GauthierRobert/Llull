// Redline geometry (pure): pointer position -> normalised viewpoint-image point, the points a drag makes per tool, and SVG outlines.
// Screen points are [x, y] in [0, 1]^2 with the origin top-left (the `add_markup` convention).

import type { Vec2 } from '@core/model/vectors';
import type { RedlineTool } from '@ui/store/redlineStore';

export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Pointer position in the viewport rectangle as a normalised point; null for an empty rectangle. */
export function toNormalised(clientX: number, clientY: number, rect: PixelRect): Vec2 | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return [clamp01((clientX - rect.left) / rect.width), clamp01((clientY - rect.top) / rect.height)];
}

/** A drag shorter than this (normalised) draws nothing. */
const MIN_DRAG = 0.01;

/** The points `add_markup` takes for a drag from `from` to `to`; null when the drag is too short. A text markup takes its anchor only. */
export function markupPoints(tool: RedlineTool, from: Vec2, to: Vec2): Vec2[] | null {
  if (tool === 'text') return [from];
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) < MIN_DRAG) return null;
  if (tool === 'cloud') return [from, [to[0], from[1]], to, [from[0], to[1]]];
  return [from, to];
}

const px = (point: Vec2, width: number, height: number): Vec2 => [point[0] * width, point[1] * height];
const fixed = (value: number): string => String(Math.round(value * 100) / 100);

/** Polyline "x,y x,y" in pixels. */
export function pointsAttribute(points: readonly Vec2[], width: number, height: number): string {
  return points
    .map((point) => px(point, width, height))
    .map(([x, y]) => `${fixed(x)},${fixed(y)}`)
    .join(' ');
}

/** The two barbs of an arrow head at `head`, in pixels. */
export function arrowBarbs(tail: Vec2, head: Vec2, width: number, height: number, size = 12): [Vec2, Vec2] {
  const [tx, ty] = px(tail, width, height);
  const [hx, hy] = px(head, width, height);
  const angle = Math.atan2(hy - ty, hx - tx);
  const spread = Math.PI / 7;
  return [
    [hx - size * Math.cos(angle - spread), hy - size * Math.sin(angle - spread)],
    [hx - size * Math.cos(angle + spread), hy - size * Math.sin(angle + spread)],
  ];
}

/**
 * Revision cloud outline through `points` (closed polygon, pixels): one outward arc per `bump` pixels of each edge.
 * @invariant the arcs bulge outward whichever way the polygon is wound
 */
export function cloudPath(points: readonly Vec2[], width: number, height: number, bump = 16): string {
  const pixels = points.map((point) => px(point, width, height));
  const first = pixels[0];
  if (first === undefined || pixels.length < 3) return '';
  const area = pixels.reduce((sum, [x, y], index) => {
    const [nx, ny] = pixels[(index + 1) % pixels.length] ?? first;
    return sum + (x * ny - nx * y);
  }, 0);
  // In SVG's y-down space a positive shoelace sum is clockwise on screen; an outward bulge then needs sweep 1.
  const sweep = area >= 0 ? 1 : 0;
  let path = `M${fixed(first[0])},${fixed(first[1])}`;
  pixels.forEach(([x, y], index) => {
    const [nx, ny] = pixels[(index + 1) % pixels.length] ?? first;
    const length = Math.hypot(nx - x, ny - y);
    const count = Math.max(1, Math.round(length / bump));
    const radius = length / count / 2;
    for (let step = 1; step <= count; step += 1) {
      const t = step / count;
      path += ` A${fixed(radius)},${fixed(radius)} 0 0 ${sweep} ${fixed(x + (nx - x) * t)},${fixed(y + (ny - y) * t)}`;
    }
  });
  return `${path} Z`;
}
