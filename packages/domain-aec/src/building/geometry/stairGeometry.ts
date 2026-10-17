/** Stair plan frame. */

import type { StairElement } from '@core/model/building';
import type { Vec2 } from '@core/model/types';

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
