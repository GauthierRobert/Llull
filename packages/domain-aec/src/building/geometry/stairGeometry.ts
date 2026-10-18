/** Stair plan frame. */

import type { StairElement } from '@core/model/building';
import type { Vec2 } from '@core/model/types';
import { polygonArea } from '@lib/polygon';

/** Plan point `along` the run from the stair start and `across` it (left of travel positive). */
export function stairPoint(stair: StairElement, along: number, across: number): Vec2 {
  const [cos, sin] = [Math.cos(stair.angle), Math.sin(stair.angle)];
  return [stair.start[0] + cos * along - sin * across, stair.start[1] + sin * along + cos * across];
}

/** One solid step: plan span along the run and heights above the stair base. */
export interface StairTread {
  readonly alongStart: number;
  readonly alongEnd: number;
  readonly zBottom: number;
  readonly zTop: number;
}

/** Waist-slab thickness (perpendicular to the flight); stairs saved without one use the riser height (about 150-190 mm). */
function waistOf(stair: StairElement): number {
  return stair.waistThickness ?? stair.riserHeight;
}

/**
 * Steps of a waist-slab stair: `riserCount - 1` treads (the last riser arrives on the upper floor, which is the landing). Each tread
 * is a block from its top down to the sloping soffit at mid-tread, so the solid is the waist slab plus the step wedges (not a solid
 * mass down to the floor). Heights are relative to the stair base.
 * @invariant treads[k].zTop = (k + 1) * riserHeight; soffit never below the base
 */
export function stairTreads(stair: StairElement): StairTread[] {
  const { riserHeight: rise, treadDepth: going } = stair;
  const verticalWaist = (waistOf(stair) * Math.hypot(rise, going)) / going;
  return Array.from({ length: Math.max(stair.riserCount - 1, 0) }, (_, index) => ({
    alongStart: index * going,
    alongEnd: (index + 1) * going,
    zBottom: Math.max(0, (index + 0.5) * rise - verticalWaist),
    zTop: (index + 1) * rise,
  }));
}

/**
 * Side profile (along the run, height above the stair base) of the whole flight as ONE solid: stepped top, and an underside that is the
 * sloping waist slab. The waist line runs parallel to the pitch and passes `waistThickness` (perpendicular) below the step roots
 * (z = along * rise / going); it is clipped by the base level.
 * @returns counter-clockwise outline; empty when there is no tread
 */
export function stairProfile(stair: StairElement): Vec2[] {
  const { riserHeight: rise, treadDepth: going, riserCount } = stair;
  const treads = Math.max(riserCount - 1, 0);
  if (treads === 0) return [];
  const length = treads * going;
  const verticalWaist = (waistOf(stair) * Math.hypot(rise, going)) / going;
  const soffitAt = (along: number): number => (along * rise) / going - verticalWaist;
  const clampAlong = Math.min(length, (verticalWaist * going) / rise);
  const outline: Vec2[] = [[0, 0]];
  if (clampAlong > 0) outline.push([clampAlong, 0]);
  if (clampAlong < length) outline.push([length, soffitAt(length)]);
  outline.push([length, treads * rise]);
  for (let tread = treads - 1; tread >= 0; tread--) {
    outline.push([tread * going, (tread + 1) * rise]);
    if (tread > 0) outline.push([tread * going, tread * rise]);
  }
  return outline;
}

/** Concrete volume of the flight (document units³): profile area times width. */
export function stairFlightVolume(stair: StairElement): number {
  const outline = stairProfile(stair);
  return polygonArea(outline) * stair.width;
}
