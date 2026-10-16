// Pure helpers of the involute overlay: moving frames (tangent / normal) read off a sampled involute polyline.

import type { Vec2 } from '@core/model/types';

export interface InvoluteFrame {
  point: Vec2;
  /** Unit tangent, in the direction of travel. */
  tangent: Vec2;
  /** Unit normal (tangent rotated +90 degrees). For an involute it is tangent to the base circle. */
  normal: Vec2;
}

/** `draw_involute` mints ids `inv-<step>.<k>`; the overlay is a presentation of that origin, not a new entity kind. */
export const isInvoluteId = (id: string): boolean => id.startsWith('inv-');

/** Frame at vertex `index` (central difference inside, one-sided at the ends); null when degenerate. */
function frameAt(points: ReadonlyArray<Vec2>, index: number): InvoluteFrame | null {
  const point = points[index];
  const before = points[Math.max(index - 1, 0)];
  const after = points[Math.min(index + 1, points.length - 1)];
  if (!point || !before || !after) return null;
  const dx = after[0] - before[0];
  const dy = after[1] - before[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  const tangent: Vec2 = [dx / length, dy / length];
  return { point, tangent, normal: [-tangent[1], tangent[0]] };
}

/** Frames at the start, middle and end of the curve, plus the arrow length (15% of the chord). */
export function involuteOverlay(points: ReadonlyArray<Vec2>): { frames: InvoluteFrame[]; arrow: number } {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length < 3 || !first || !last) return { frames: [], arrow: 0 };
  const indices = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const frames = indices.flatMap((index) => frameAt(points, index) ?? []);
  return { frames, arrow: 0.15 * Math.hypot(last[0] - first[0], last[1] - first[1]) };
}

/** Flat xyz segment pairs: one tangent and one normal arrow shaft per frame. */
export function overlaySegments(frames: ReadonlyArray<InvoluteFrame>, arrow: number): { tangents: number[]; normals: number[] } {
  const tangents: number[] = [];
  const normals: number[] = [];
  for (const { point, tangent, normal } of frames) {
    tangents.push(point[0], point[1], 0, point[0] + tangent[0] * arrow, point[1] + tangent[1] * arrow, 0);
    normals.push(point[0], point[1], 0, point[0] + normal[0] * arrow, point[1] + normal[1] * arrow, 0);
  }
  return { tangents, normals };
}
