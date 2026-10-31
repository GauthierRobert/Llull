/** Takeoff lines and schedule rows of the access elements (06 STA): grating m2 / kg per type, railing m / posts / steel kg. */

import type { CadDocument } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { BuildingModel } from '@aec/building/types';
import { elementsOf } from '../../../building/model';
import type { TakeoffAccumulator } from '../../../building/quantities/takeoffBasics';
import { round } from '../../../shared/numeric';
import { gratingAreaM2, gratingMassKg } from '../grating/gratingMeasure';
import { ladderQuantities } from '../ladder/ladderMeasure';

import { railingQuantities } from '../railing/railingMeasure';
import { stairGeometryMm, stairQuantities } from '../stair/steelStairMeasure';

/** Adds `steelStair.<part>.m|ea|kg`, `grating.<type>.m2|kg|ea`, `railing.<part>.m|ea|kg` and `ladder.<part>.ea|m|kg` lines. */
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
  for (const ladder of elementsOf(building, 'ladder')) {
    const quantities = ladderQuantities(doc, ladder);
    takeoff.add('ladder', 'rung', 'Ladder rungs', [['ea', 'count', quantities.rungs]]);
    if (quantities.cageM > 0) takeoff.add('ladder', 'cage', 'Ladder cages', [['m', 'height, first hoop to stile top', quantities.cageM]]);
    if (quantities.landings > 0) takeoff.add('ladder', 'landing', 'Ladder landings', [['ea', 'count', quantities.landings]]);
    takeoff.add('ladder', 'steel', 'Ladder steel', [['kg', 'stiles, rungs, cage and landings', quantities.steelKg]]);
  }
  for (const stair of elementsOf(building, 'steelStair')) {
    const quantities = stairQuantities(doc, stair);
    takeoff.add('steelStair', 'stringer', 'Steel stair stringers', [['m', 'centre-line length, both sides', quantities.stringerM]]);
    takeoff.add('steelStair', 'tread', 'Steel stair treads', [['ea', 'count', quantities.treads]]);
    if (quantities.landings > 0) takeoff.add('steelStair', 'landing', 'Steel stair landings', [['ea', 'count', quantities.landings]]);
    takeoff.add('steelStair', 'steel', 'Steel stair steel', [['kg', 'stringers, treads and landings', quantities.steelKg]]);
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

/** Ladder schedule: mark, height (mm), rungs, pitch (mm), clear width (mm), fall protection, landings, back clearance (mm), steel kg, level. */
export function ladderScheduleRows(doc: CadDocument, building: BuildingModel): Row[] {
  return elementsOf(building, 'ladder').map((ladder) => [
    ladder.mark,
    round(toMm(doc, ladder.climbHeight), 1),
    ladder.rungCount,
    round(toMm(doc, ladder.rungPitch), 3),
    round(toMm(doc, ladder.clearWidth), 1),
    ladder.fallProtection,
    ladder.landings.length,
    round(toMm(doc, ladder.backClearance), 1),
    round(ladderQuantities(doc, ladder).steelKg, 1),
    building.levels[ladder.levelId]?.name ?? ladder.levelId,
  ]);
}

/** Steel stair schedule: mark, rise (mm), risers, riser (mm), going (mm), width (mm), pitch (deg), 2h+g (mm), landings, stringer, tread, steel kg, level. */
export function steelStairScheduleRows(doc: CadDocument, building: BuildingModel): Row[] {
  return elementsOf(building, 'steelStair').map((stair) => {
    const geometry = stairGeometryMm(doc, stair);
    return [
      stair.mark,
      round(toMm(doc, stair.rise), 1),
      stair.riserCount,
      round(geometry.riser, 3),
      round(geometry.going, 1),
      round(toMm(doc, stair.width), 1),
      round(geometry.pitchDeg, 3),
      round(geometry.blondel, 2),
      stair.landings.length,
      stair.stringerProfile,
      stair.tread.kind === 'grating' ? stair.tread.gratingType : `plate ${round(toMm(doc, stair.tread.thickness), 1)}`,
      round(stairQuantities(doc, stair).steelKg, 1),
      building.levels[stair.levelId]?.name ?? stair.levelId,
    ];
  });
}
