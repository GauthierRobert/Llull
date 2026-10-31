/**
 * Layout of a fixed ladder (06 STA §5.1): stiles, rungs, cage hoops and bars, landing plates. Pure geometry in document units; z is relative to
 * the level. The catalogue sections are named constants (the pack does not fix them): flat-bar stiles, round rungs, flat-bar hoops.
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type { LadderElement } from '@aec/building/types';

export const STILE_PROFILE = 'FL70x10';
export const RUNG_PROFILE = 'RD20';
export const HOOP_PROFILE = 'FL50x5';
export const CAGE_BAR_PROFILE = 'RD12';

/** Landing plate: thickness, depth on the climber's side and side margin beyond the stiles, mm. */
export const LANDING_THICKNESS_MM = 6;
export const LANDING_DEPTH_MM = 600;
export const LANDING_MARGIN_MM = 200;

/** Half-angle of the cage arc around the climber's back (240 degrees in all) and the angle step of the discretised hoop (§8: 5 degrees). */
const CAGE_HALF_ANGLE = (2 * Math.PI) / 3;
const ARC_STEP = (5 * Math.PI) / 180;

export interface LadderRun {
  readonly from: Vec3;
  readonly to: Vec3;
}

export interface LandingPlate {
  /** Plan corners, document units. */
  readonly corners: ReadonlyArray<Vec2>;
  /** Top of the plate, level-relative. */
  readonly top: number;
}

export interface LadderLayout {
  readonly stiles: ReadonlyArray<LadderRun>;
  readonly rungs: ReadonlyArray<LadderRun>;
  /** Straight pieces of every hoop arc. */
  readonly hoops: ReadonlyArray<LadderRun>;
  readonly bars: ReadonlyArray<LadderRun>;
  readonly landings: ReadonlyArray<LandingPlate>;
  /** Hoop heights above the base. */
  readonly hoopHeights: ReadonlyArray<number>;
}

type LayoutInput = Pick<
  LadderElement,
  'base' | 'facing' | 'climbHeight' | 'clearWidth' | 'rungPitch' | 'rungCount' | 'cage' | 'landings' | 'railExtension'
>;

/** Millimetre sizes of the section constants, converted by the caller (`mmUnit` = document units per mm). */
export interface LadderSizes {
  readonly stileThickness: number;
  readonly mmUnit: number;
}

/** Hoop heights above the base: from `startHeight` to the stile top at equal spacing <= `hoopSpacing` (none when the cage starts above the top). */
export function hoopHeightsOf(cage: NonNullable<LadderElement['cage']>, top: number): number[] {
  if (!(top > cage.startHeight) || !(cage.hoopSpacing > 0)) return [];
  const spaces = Math.max(1, Math.ceil((top - cage.startHeight) / cage.hoopSpacing - 1e-9));
  return Array.from({ length: spaces + 1 }, (_, index) => cage.startHeight + ((top - cage.startHeight) * index) / spaces);
}

/** Cage arc angle offsets (radians from the back direction), `count` points from -120 to +120 degrees. */
const arcAngles = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => (count === 1 ? 0 : -CAGE_HALF_ANGLE + (2 * CAGE_HALF_ANGLE * index) / (count - 1)));

export function layoutLadder(ladder: LayoutInput, sizes: LadderSizes): LadderLayout {
  const [bx, by, bz] = ladder.base;
  const forward: Vec2 = [Math.cos(ladder.facing), Math.sin(ladder.facing)];
  const left: Vec2 = [-forward[1], forward[0]];
  const at = (along: number, side: number, height: number): Vec3 => [
    bx + forward[0] * along + left[0] * side,
    by + forward[1] * along + left[1] * side,
    bz + height,
  ];
  const stileTop = ladder.climbHeight + ladder.railExtension;
  const offset = ladder.clearWidth / 2 + sizes.stileThickness / 2;
  const stiles = [offset, -offset].map((side): LadderRun => ({ from: at(0, side, 0), to: at(0, side, stileTop) }));
  const rungs = Array.from({ length: ladder.rungCount }, (_, index): LadderRun => {
    const height = (index + 1) * ladder.rungPitch;
    return { from: at(0, offset, height), to: at(0, -offset, height) };
  });

  const hoops: LadderRun[] = [];
  const bars: LadderRun[] = [];
  const hoopHeights = ladder.cage === undefined ? [] : hoopHeightsOf(ladder.cage, stileTop);
  if (ladder.cage !== undefined && hoopHeights.length > 0) {
    const radius = ladder.cage.diameter / 2;
    const onArc = (angle: number, height: number): Vec3 => at(-radius / 2 - radius * Math.cos(angle), radius * Math.sin(angle), height);
    const steps = Math.ceil((2 * CAGE_HALF_ANGLE) / ARC_STEP - 1e-9);
    const angles = arcAngles(steps + 1);
    for (const height of hoopHeights)
      for (let index = 1; index < angles.length; index++)
        hoops.push({ from: onArc(angles[index - 1] as number, height), to: onArc(angles[index] as number, height) });
    for (const angle of arcAngles(ladder.cage.bars))
      bars.push({ from: onArc(angle, hoopHeights[0] as number), to: onArc(angle, hoopHeights[hoopHeights.length - 1] as number) });
  }

  const half = ladder.clearWidth / 2 + sizes.stileThickness + LANDING_MARGIN_MM * sizes.mmUnit;
  const landings = ladder.landings.map((height): LandingPlate => {
    const corner = (along: number, side: number): Vec2 => {
      const point = at(along, side, 0);
      return [point[0], point[1]];
    };
    const depth = LANDING_DEPTH_MM * sizes.mmUnit;
    return { corners: [corner(0, -half), corner(0, half), corner(-depth, half), corner(-depth, -half)], top: bz + height };
  });
  return { stiles, rungs, hoops, bars, landings, hoopHeights };
}
