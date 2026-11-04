/** Plan footprint and height range of an oriented box (convex hull of its eight corners), for the ray tests of the ladder back clearance. */

import type { Vec2 } from '@core/model/types';
import type { OrientedBox } from '../../../industrial/clash/clashBoxes';

export interface BoxFootprint {
  readonly ring: ReadonlyArray<Vec2>;
  readonly zMin: number;
  readonly zMax: number;
}

const turn = (o: Vec2, a: Vec2, b: Vec2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone chain; collinear and duplicate points are dropped. */
function hull(points: ReadonlyArray<Vec2>): Vec2[] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const half = (input: ReadonlyArray<Vec2>): Vec2[] => {
    const chain: Vec2[] = [];
    for (const point of input) {
      while (chain.length >= 2 && turn(chain[chain.length - 2] as Vec2, chain[chain.length - 1] as Vec2, point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** The convex plan outline (counter-clockwise) and the z range of `box`. */
export function boxFootprint(box: OrientedBox): BoxFootprint {
  const corners: Array<[number, number, number]> = [];
  for (const a of [-1, 1])
    for (const b of [-1, 1])
      for (const c of [-1, 1]) {
        const offset = [0, 1, 2].map(
          (axis) =>
            a * box.half[0] * (box.axes[0]?.[axis] ?? 0) +
            b * box.half[1] * (box.axes[1]?.[axis] ?? 0) +
            c * box.half[2] * (box.axes[2]?.[axis] ?? 0),
        );
        corners.push([box.center[0] + (offset[0] ?? 0), box.center[1] + (offset[1] ?? 0), box.center[2] + (offset[2] ?? 0)]);
      }
  const zs = corners.map((corner) => corner[2]);
  return { ring: hull(corners.map((corner): Vec2 => [corner[0], corner[1]])), zMin: Math.min(...zs), zMax: Math.max(...zs) };
}
