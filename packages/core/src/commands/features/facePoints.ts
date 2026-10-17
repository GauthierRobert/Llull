/** Coordinates of hole centres / outline vertices on a picked face: the three `pointsFrame` conventions (07 FTR §4.1). */

import type { Vec2 } from '../../model/types';
import type { FeatureFrame } from '../../model/features';
import { worldToFrame } from '../../geometry/featureFrame';
import { dot3 } from '../../lib/vec3';

export const POINT_FRAMES = ['face', 'world_xy', 'world'] as const;

/** Local face coordinates of each requested point, or the indices that cannot be placed. */
export function localPoints(
  frame: FeatureFrame,
  points: ReadonlyArray<readonly number[]>,
  pointsFrame: (typeof POINT_FRAMES)[number],
): { local: Vec2[]; bad: number[] } {
  const local: Vec2[] = [];
  const bad: number[] = [];
  const planeZ = (x: number, y: number): number | null =>
    Math.abs(frame.normal[2]) < 1e-9
      ? null
      : (dot3(frame.normal, frame.origin) - frame.normal[0] * x - frame.normal[1] * y) / frame.normal[2];
  points.forEach((point, index) => {
    const [a, b, c] = point;
    const finite = point.every(Number.isFinite);
    let placed: Vec2 | null = null;
    if (finite && pointsFrame === 'face' && point.length === 2) placed = [a as number, b as number];
    else if (finite && pointsFrame === 'world' && point.length === 3) placed = worldToFrame(frame, [a as number, b as number, c as number]);
    else if (finite && pointsFrame === 'world_xy' && point.length === 2) {
      const z = planeZ(a as number, b as number);
      placed = z === null ? null : worldToFrame(frame, [a as number, b as number, z]);
    }
    if (placed === null) bad.push(index);
    else local.push(placed);
  });
  return { local, bad };
}

export const expectedShape: Readonly<Record<(typeof POINT_FRAMES)[number], string>> = {
  face: '[u, v] in the face frame',
  world_xy: '[x, y] world coordinates (face not parallel to Z)',
  world: '[x, y, z] world coordinates',
};
