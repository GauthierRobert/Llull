/**
 * Footing and base-plate check rows of the analysed columns of a level (soil, uplift, sliding, tie, plate, settlement).
 * @layer domain-aec
 * @pure
 */

import type { FootingElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { getBuilding } from '../model';
import type { FrameLoads } from './frameModelTypes';
import { baseReactions } from './frameModelSolve';
import { type ClayLayer, type FoundationRow, MAX_UTILISATION } from './foundationModel';
import { DEFAULT_SOIL_MODULUS } from './soilParams';
import { differentialRows, footingRows } from './foundationRows';
import { plateRows } from './foundationPlateRows';
import { groundSlabWeight, slidingHorizontalOf } from './foundationThrust';
import {
  combine,
  findFooting,
  findPlate,
  hasCase,
  ultimateCombinations,
} from './foundationCombinations';
import { footingSettlementParts } from './foundationSettlement';
import { round } from '../numeric';

/**
 * Checks footings and base plates of the columns of a level.
 * @pure
 */
export function checkFoundations(
  doc: CadDocument,
  levelId: string,
  loads: FrameLoads,
  soilBearing: number,
  thrustTie: boolean,
  tieCapacity: number,
  soilModulus: number = DEFAULT_SOIL_MODULUS,
  clayLayer?: ClayLayer,
): { rows: FoundationRow[]; footings: number; plates: number; unchecked: number } {
  const building = getBuilding(doc);
  const wind = loads.windPressure > 0;
  const rows: FoundationRow[] = [];
  let footings = 0;
  let plates = 0;
  const reactions = baseReactions(doc, building, levelId, loads);
  const checkedFootings = new Set<string>();
  const tieDone = new Set<string>();
  const slabWeight = thrustTie ? groundSlabWeight(doc, building, levelId) : 0;
  const settlements: Array<{
    frame: string;
    x: number;
    column: string;
    footing: FootingElement;
    settlement: number;
  }> = [];
  const slabShare = reactions.length > 0 ? slabWeight / reactions.length : 0;
  for (const reaction of reactions) {
    const column = building.elements[reaction.columnId];
    if (column?.category !== 'member') continue;
    const siblings = reactions.filter((other) => other.frame === reaction.frame);
    const slidingHorizontal = slidingHorizontalOf(reactions, reaction, thrustTie);
    const footing = findFooting(doc, building, levelId, column);
    const plate = findPlate(building, column.id);
    if (thrustTie && !tieDone.has(reaction.frame) && (footing || plate)) {
      tieDone.add(reaction.frame);
      const gravity = ultimateCombinations(
        wind,
        siblings.some((other) => hasCase(other, 'CL') || hasCase(other, 'CR')),
        false,
      ).filter((combination) => !/W/.test(combination.name));
      const tie = gravity
        .flatMap((combination) =>
          siblings.map((other) => ({
            other,
            combination,
            force: Math.abs(combine(other, combination.factors).h),
          })),
        )
        .reduce((best, item) => (item.force > best.force ? item : best));
      rows.push({
        column: reaction.frame,
        footing: '—',
        elementId: tie.other.columnId,
        check: `thrust tie force (assumed 2 H16 B500 = ${round(tieCapacity, 0)} kN)`,
        value: tie.force,
        limit: tieCapacity,
        unit: 'kN',
        utilisation: Math.min(tie.force / tieCapacity, MAX_UTILISATION),
        combination: tie.combination.name,
      });
    }
    if (footing) {
      footings += 1;
      checkedFootings.add(footing.id);
      rows.push(
        ...footingRows(
          doc,
          reaction,
          column.mark,
          footing,
          soilBearing,
          wind,
          slidingHorizontal,
          slabShare,
          soilModulus,
          clayLayer,
        ),
      );
      settlements.push({
        frame: reaction.frame,
        x: footing.location[0],
        column: column.mark,
        footing,
        settlement: footingSettlementParts(doc, reaction, footing, soilModulus, clayLayer).total,
      });
    }
    if (plate) {
      plates += 1;
      rows.push(
        ...plateRows(doc, building, reaction, column.mark, footing?.mark ?? '—', plate, wind),
      );
    }
  }
  rows.push(...differentialRows(doc, settlements));
  const unchecked = Object.values(building.elements).filter(
    (element) =>
      element.category === 'footing' &&
      element.levelId === levelId &&
      !checkedFootings.has(element.id),
  ).length;
  return { rows, footings, plates, unchecked };
}
