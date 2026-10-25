/** Takeoff lines and schedule rows of the access elements (06 STA): grating m2 / kg per type, railing m / posts / steel kg. */

import type { CadDocument } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { BuildingModel } from '@aec/building/types';
import { elementsOf } from '../../../building/model';
import type { TakeoffAccumulator } from '../../../building/quantities/takeoffBasics';
import { round } from '../../../shared/numeric';
import { gratingAreaM2, gratingMassKg } from '../grating/gratingMeasure';
import { railingQuantities } from '../railing/railingMeasure';

/** Adds `grating.<type>.m2|kg|ea` and `railing.<part>.m|ea|kg` lines. */
export function addAccessTakeoff(doc: CadDocument, building: BuildingModel, takeoff: TakeoffAccumulator): void {
  for (const grating of elementsOf(building, 'grating')) {
    takeoff.add('grating', grating.gratingType, `Grating ${grating.gratingType}`, [
      ['m2', 'plan area', gratingAreaM2(doc, grating)],
      ['kg', 'mass', gratingMassKg(doc, grating)],
      ['ea', 'panels', 1],
    ]);
  }
  for (const railing of elementsOf(building, 'railing')) {
    const quantities = railingQuantities(doc, railing);
    if (quantities === null) continue;
    takeoff.add('railing', 'rail', 'Railing rails', [['m', 'top and knee rails', quantities.railLengthM]]);
    takeoff.add('railing', 'post', 'Railing posts', [['ea', 'count', quantities.posts]]);
    if (quantities.toeLengthM > 0) takeoff.add('railing', 'toe-plate', 'Railing toe plates', [['m', 'length', quantities.toeLengthM]]);
    if (quantities.gates > 0) takeoff.add('railing', 'gate', 'Railing gates', [['ea', 'count', quantities.gates]]);
    takeoff.add('railing', 'steel', 'Railing steel', [['kg', 'posts, rails, toe plates and gates', quantities.steelKg]]);
  }
}

type Row = Array<string | number>;

/** Grating schedule: mark, type, supports, span (mm), area, mass, level. */
export function gratingScheduleRows(doc: CadDocument, building: BuildingModel): Row[] {
  return elementsOf(building, 'grating').map((grating) => [
    grating.mark,
    grating.gratingType,
    grating.supportIds.map((side) => side.map((id) => building.elements[id]?.mark ?? id).join('+')).join(' / '),
    round(gratingAreaM2(doc, grating), 3),
    round(gratingMassKg(doc, grating), 1),
    building.levels[grating.levelId]?.name ?? grating.levelId,
  ]);
}

/** Railing schedule: mark, role, length (m), posts, heights in mm, rails, level. */
export function railingScheduleRows(doc: CadDocument, building: BuildingModel): Row[] {
  return elementsOf(building, 'railing').map((railing) => {
    const quantities = railingQuantities(doc, railing);
    return [
      railing.mark,
      railing.role,
      round(quantities?.lengthM ?? 0, 2),
      quantities?.posts ?? 0,
      round(toMm(doc, railing.height), 1),
      railing.kneeRails + 1,
      round(toMm(doc, railing.toePlate), 1),
      round(quantities?.steelKg ?? 0, 1),
      building.levels[railing.levelId]?.name ?? railing.levelId,
    ];
  });
}
