/** Quantities and derived measures of a steel stair (06 STA M5): the layout, stringer / tread / landing mass, pitch and Blondel. */

import type { CadDocument } from '@core/model/types';
import { fromMm, toMetres, toMm } from '@core/model/units';
import { polygonArea } from '@lib/polygon';
import type { SteelStairElement } from '@aec/building/types';
import { STEEL_DENSITY_KG_PER_M3, findProfile } from '../../../steel/profiles';
import { findGratingType } from '../grating/gratingTypes';
import { layoutSteelStair, type StairLayout, type StairSizes } from './steelStairLayout';

/** Section sizes of the stringers in document units (0 when the profile left the catalogue). */
export function stairSizes(doc: CadDocument, stair: Pick<SteelStairElement, 'stringerProfile'>): StairSizes {
  const profile = findProfile(stair.stringerProfile);
  return { stringerWeb: fromMm(doc, profile?.tw ?? 0), stringerDepth: fromMm(doc, profile?.h ?? 0) };
}

/** Thickness of the treads and landings, document units (0 for a grating type that left the catalogue). */
export function treadThickness(doc: CadDocument, tread: SteelStairElement['tread']): number {
  return tread.kind === 'checker_plate' ? tread.thickness : fromMm(doc, findGratingType(tread.gratingType)?.barDepthMm ?? 0);
}

export interface StairQuantities {
  readonly layout: StairLayout;
  readonly treads: number;
  readonly landings: number;
  readonly stringerM: number;
  readonly treadAreaM2: number;
  readonly stringerKg: number;
  readonly treadKg: number;
  readonly steelKg: number;
}

export function stairQuantities(doc: CadDocument, stair: SteelStairElement): StairQuantities {
  const layout = layoutSteelStair(stair, stairSizes(doc, stair));
  const metres = toMetres(doc, 1);
  const stringerM =
    layout.stringers.reduce((sum, run) => sum + Math.hypot(run.to[0] - run.from[0], run.to[1] - run.from[1], run.to[2] - run.from[2]), 0) *
    metres;
  const treadAreaM2 =
    [...layout.treads, ...layout.landings].reduce((sum, plate) => sum + polygonArea([...plate.corners]), 0) * metres * metres;
  const perArea =
    stair.tread.kind === 'grating'
      ? (findGratingType(stair.tread.gratingType)?.massKgM2 ?? 0)
      : (toMm(doc, stair.tread.thickness) / 1000) * STEEL_DENSITY_KG_PER_M3;
  const stringerKg = stringerM * (findProfile(stair.stringerProfile)?.massPerMetre ?? 0);
  const treadKg = treadAreaM2 * perArea;
  return {
    layout,
    treads: layout.treads.length,
    landings: layout.landings.length,
    stringerM,
    treadAreaM2,
    stringerKg,
    treadKg,
    steelKg: stringerKg + treadKg,
  };
}

export interface StairGeometryMm {
  readonly riser: number;
  readonly going: number;
  readonly pitchDeg: number;
  readonly blondel: number;
  readonly run: number;
}

/** Stair measures in mm and degrees: riser, going, pitch, Blondel 2h + g, run. */
export function stairGeometryMm(doc: CadDocument, stair: SteelStairElement): StairGeometryMm {
  const [riser, going] = [toMm(doc, stair.riserHeight), toMm(doc, stair.going)];
  const run = layoutSteelStair(stair, stairSizes(doc, stair)).run;
  return { riser, going, pitchDeg: (Math.atan2(riser, going) * 180) / Math.PI, blondel: 2 * riser + going, run: toMm(doc, run) };
}
