/**
 * Ground-slab weight and horizontal-thrust sharing for footing sliding.
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { getBuilding } from '../../building/model';
import { polygonArea } from '@lib/polygon';
import type { BaseReaction } from '../frames/frameModelSolve';
import { CONCRETE_UNIT_WEIGHT, type Factors } from './foundationModel';
import { combine } from './foundationCombinations';

/** Weight (kN) of the ground slabs of a level (their friction is shared per column for tied frames). */
export function groundSlabWeight(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
): number {
  return Object.values(building.elements).reduce(
    (sum, element) =>
      element.category === 'slab' && element.levelId === levelId
        ? sum +
          CONCRETE_UNIT_WEIGHT *
            polygonArea(
              element.boundary.map(([x, y]): [number, number] => [
                toMetres(doc, x),
                toMetres(doc, y),
              ]),
            ) *
            toMetres(doc, element.thickness)
        : sum,
    0,
  );
}

/** Ground-slab weight (kN) carried by each of `columnCount` columns; 0 without thrust tie. */
export function slabSharePerColumn(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  thrustTie: boolean,
  columnCount: number,
): number {
  return thrustTie && columnCount > 0 ? groundSlabWeight(doc, building, levelId) / columnCount : 0;
}

/** The steel column a base reaction belongs to; undefined when it is not a member. */
export function reactionColumn(
  building: BuildingModel,
  reaction: BaseReaction,
): SteelMemberElement | undefined {
  const column = building.elements[reaction.columnId];
  return column?.category === 'member' ? column : undefined;
}

/** Horizontal force (kN) resisted by one pad: shared across the frame columns when `thrustTie`. */
export function slidingHorizontalOf(
  reactions: ReadonlyArray<BaseReaction>,
  reaction: BaseReaction,
  thrustTie: boolean,
): (factors: Factors) => number {
  const siblings = reactions.filter((other) => other.frame === reaction.frame);
  return (factors) =>
    thrustTie
      ? siblings.reduce((sum, other) => sum + combine(other, factors).h, 0) / siblings.length
      : combine(reaction, factors).h;
}

/** Tie / slab assumed by default when the level has a slab element. */
export function defaultThrustTie(doc: CadDocument, levelId: string): boolean {
  return Object.values(getBuilding(doc).elements).some(
    (element) => element.category === 'slab' && element.levelId === levelId,
  );
}
