/**
 * Base plate design of fixed column bases: lightest catalogue plate + anchor bolts for M + N.
 * @layer domain-aec
 */

import type { BasePlateElement, BuildingModel } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { elementsOf, fromMm, withElement } from '../model';
import { findProfile } from '../steel/profiles';
import { sizeBasePlate, type PlateDemand } from './basePlateMN';
import { plateDemands } from './foundationCombinations';
import { type FrameLoads } from './frameModelTypes';
import { baseReactions } from './frameModelSolve';
import { yieldStrength } from './steelDesign';

/**
 * Sizes every fixed base plate of a level (one catalogue entry per column profile, from the worst
 * demands of all its columns) and stores plate size, thickness, bolt count and diameter on it.
 * @pure
 */
export function designFixedPlates(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  loads: FrameLoads,
  target: number,
): { building: BuildingModel; changed: string[]; descriptions: string[]; unresolved: number } {
  const reactions = baseReactions(doc, building, levelId, loads);
  const wind = loads.windPressure > 0;
  const groups = new Map<string, { plates: BasePlateElement[]; demands: PlateDemand[] }>();
  for (const reaction of reactions) {
    const plate = elementsOf(building, 'plate').find(
      (candidate) => candidate.memberId === reaction.columnId && candidate.fixity === 'fixed',
    );
    const column = building.elements[reaction.columnId];
    if (!plate || column?.category !== 'member') continue;
    const group = groups.get(column.profile) ?? { plates: [], demands: [] };
    group.plates.push(plate);
    group.demands.push(...plateDemands(reaction, wind));
    groups.set(column.profile, group);
  }
  let next = building;
  const changed: string[] = [];
  const descriptions: string[] = [];
  let unresolved = 0;
  for (const [profileName, group] of groups) {
    const profile = findProfile(profileName);
    if (!profile) continue;
    const { sizing, passes } = sizeBasePlate(
      { depth: profile.h, width: profile.b },
      group.demands,
      yieldStrength(group.plates[0]?.material ?? 'S355'),
      target,
    );
    if (!passes) unresolved += 1;
    descriptions.push(
      `${profileName} fixed bases: plate ${profile.h + 2 * sizing.margin} × ${profile.b + 2 * sizing.margin} × ${sizing.thickness}, ${sizing.boltCount} × M${sizing.boltDiameter}${passes ? '' : ' (largest catalogue plate, still failing)'}`,
    );
    for (const plate of group.plates) {
      const resized: BasePlateElement = {
        ...plate,
        length: fromMm(doc, profile.h + 2 * sizing.margin),
        width: fromMm(doc, profile.b + 2 * sizing.margin),
        thickness: fromMm(doc, sizing.thickness),
        boltCount: sizing.boltCount,
        boltDiameter: fromMm(doc, sizing.boltDiameter),
      };
      if (
        resized.length === plate.length &&
        resized.width === plate.width &&
        resized.thickness === plate.thickness &&
        resized.boltCount === plate.boltCount &&
        resized.boltDiameter === plate.boltDiameter
      ) {
        continue;
      }
      next = withElement(next, resized);
      changed.push(plate.id);
    }
  }
  return { building: next, changed, descriptions, unresolved };
}
