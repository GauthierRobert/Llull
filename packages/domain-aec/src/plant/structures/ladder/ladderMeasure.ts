/** Quantities of a ladder (06 STA M4): rungs, cage length, steel mass, per the layout and the catalogue masses. */

import type { CadDocument } from '@core/model/types';
import { fromMm, toMetres } from '@core/model/units';
import type { LadderElement } from '@aec/building/types';
import { STEEL_DENSITY_KG_PER_M3, findProfile } from '../../../steel/profiles';
import {
  CAGE_BAR_PROFILE,
  HOOP_PROFILE,
  LANDING_THICKNESS_MM,
  RUNG_PROFILE,
  STILE_PROFILE,
  layoutLadder,
  type LadderLayout,
  type LadderRun,
} from './ladderLayout';

const length = (runs: ReadonlyArray<LadderRun>): number =>
  runs.reduce((sum, run) => sum + Math.hypot(run.to[0] - run.from[0], run.to[1] - run.from[1], run.to[2] - run.from[2]), 0);

/** Document units per mm and the stile thickness in document units: the sizes `layoutLadder` needs. */
export function ladderSizes(doc: CadDocument): { stileThickness: number; mmUnit: number } {
  return { stileThickness: fromMm(doc, findProfile(STILE_PROFILE)?.b ?? 0), mmUnit: fromMm(doc, 1) };
}

export interface LadderQuantities {
  readonly layout: LadderLayout;
  readonly rungs: number;
  readonly landings: number;
  /** Height of the cage, first hoop to the stile top, metres (0 without a cage). */
  readonly cageM: number;
  readonly stileKg: number;
  readonly rungKg: number;
  readonly cageKg: number;
  readonly landingKg: number;
  readonly steelKg: number;
}

/** The layout and totals of a ladder. */
export function ladderQuantities(doc: CadDocument, ladder: LadderElement): LadderQuantities {
  const layout = layoutLadder(ladder, ladderSizes(doc));
  const metres = toMetres(doc, 1);
  const mass = (name: string, runs: ReadonlyArray<LadderRun>): number => length(runs) * metres * (findProfile(name)?.massPerMetre ?? 0);
  const stileKg = mass(STILE_PROFILE, layout.stiles);
  const rungKg = mass(RUNG_PROFILE, layout.rungs);
  const cageKg = mass(HOOP_PROFILE, layout.hoops) + mass(CAGE_BAR_PROFILE, layout.bars);
  const plateArea = layout.landings.reduce((sum, plate) => {
    const [a, b, , d] = plate.corners;
    return a === undefined || b === undefined || d === undefined
      ? sum
      : sum + Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(d[0] - a[0], d[1] - a[1]) * metres * metres;
  }, 0);
  const landingKg = (plateArea * LANDING_THICKNESS_MM * STEEL_DENSITY_KG_PER_M3) / 1000;
  const first = layout.hoopHeights[0];
  const last = layout.hoopHeights[layout.hoopHeights.length - 1];
  return {
    layout,
    rungs: layout.rungs.length,
    landings: layout.landings.length,
    cageM: first === undefined || last === undefined ? 0 : (last - first) * metres,
    stileKg,
    rungKg,
    cageKg,
    landingKg,
    steelKg: stileKg + rungKg + cageKg + landingKg,
  };
}
