/**
 * Ground-slab weight and horizontal-thrust sharing for footing sliding.
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { getBuilding, toMetres } from '../model';
import { polygonArea } from '@lib/polygon';
import type { BaseReaction } from './frameModelSolve';
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
