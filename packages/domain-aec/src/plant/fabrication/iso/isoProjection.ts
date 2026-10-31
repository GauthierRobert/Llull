/**
 * True isometric projection of plant axes onto the sheet (plant 05 ISO §5.8, TR-ISO-09): east projects at -30 degrees, north at +30 degrees, up at 90 degrees,
 * the same frame as `geometry/viewDirections.ts` `iso` (scale dropped: the drawing is not to scale). `up_left` turns the plant by +90 degrees about +Z first,
 * so north projects at 150 degrees and east at +30 degrees. Pure.
 */

import type { Vec2, Vec3 } from '@core/model/vectors';

export type NorthArrow = 'up_right' | 'up_left';

/** Foreshortening of every axis in a true isometric projection, sqrt(2/3); reported for reference only. */
export const TRUE_ISO_SCALE = Math.sqrt(2 / 3);

const COS30 = Math.cos(Math.PI / 6);
const EAST: Vec2 = [COS30, -0.5];
const NORTH: Vec2 = [COS30, 0.5];

/** Direction toward the viewer in the un-turned plant frame: from (+X, -Y, +Z). */
const VIEWER: Vec3 = [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];

/** The plant vector as the projection sees it (turned by +90 degrees about +Z for `up_left`). */
export const turnedFor = (vector: Vec3, northArrow: NorthArrow): Vec3 =>
  northArrow === 'up_right' ? vector : [-vector[1], vector[0], vector[2]];

/** Sheet point (x right, y up, mm of 3D length) of a plant point or direction. */
export function projectIso(vector: Vec3, northArrow: NorthArrow): Vec2 {
  const turned = turnedFor(vector, northArrow);
  return [turned[0] * EAST[0] + turned[1] * NORTH[0], turned[0] * EAST[1] + turned[1] * NORTH[1] + turned[2]];
}

/** Larger = nearer to the viewer: decides which of two crossing pipes passes in front. */
export const depthOf = (vector: Vec3, northArrow: NorthArrow): number => {
  const turned = turnedFor(vector, northArrow);
  return turned[0] * VIEWER[0] + turned[1] * VIEWER[1] + turned[2] * VIEWER[2];
};

const angleOf = (vector: Vec2): number => (Math.atan2(vector[1], vector[0]) * 180) / Math.PI;

/** Sheet angle in degrees of the three plant axes and the north arrow (it follows the projected north). */
export function axisAngles(northArrow: NorthArrow): {
  readonly east: number;
  readonly north: number;
  readonly up: number;
  readonly northArrow: number;
} {
  const east = angleOf(projectIso([1, 0, 0], northArrow));
  const north = angleOf(projectIso([0, 1, 0], northArrow));
  return { east, north, up: angleOf(projectIso([0, 0, 1], northArrow)), northArrow: north };
}
