/** Quantities of a winder / spiral stair: tread area and mass, section length and mass. */

import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { polygonArea } from '@lib/polygon';
import type { RadialStairElement } from '@aec/building/types';
import { findProfile } from '../../../steel/profiles';
import { treadMassKgM2 } from '../stair/steelStairMeasure';

interface RadialQuantities {
  readonly treads: number;
  readonly treadAreaM2: number;
  readonly sectionM: number;
  readonly treadKg: number;
  readonly sectionKg: number;
  readonly steelKg: number;
}

export function radialQuantities(doc: CadDocument, stair: RadialStairElement): RadialQuantities {
  const metres = toMetres(doc, 1);
  const treadAreaM2 = stair.plates.reduce((sum, plate) => sum + polygonArea([...plate.corners]), 0) * metres * metres;
  const sectionM =
    stair.runs.reduce((sum, run) => sum + Math.hypot(run.to[0] - run.from[0], run.to[1] - run.from[1], run.to[2] - run.from[2]), 0) *
    metres;
  const treadKg = treadAreaM2 * treadMassKgM2(doc, stair.tread);
  const massPerMetre = findProfile(stair.profile)?.massPerMetre;
  const sectionKg = massPerMetre === undefined ? 0 : sectionM * massPerMetre;
  return { treads: stair.plates.length, treadAreaM2, sectionM, treadKg, sectionKg, steelKg: treadKg + sectionKg };
}
