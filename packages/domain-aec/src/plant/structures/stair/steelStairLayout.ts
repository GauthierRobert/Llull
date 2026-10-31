/**
 * Layout of a steel stringer stair (06 STA §5.2). Plan stations run along the climb direction: riser i stands at s_i (s_1 = 0), its tread top is at
 * i x riserHeight and spans s_i .. s_(i+1); a landing after riser k widens that span to the landing length. Pure geometry in document units, z
 * relative to the level.
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type { SteelStairElement, SteelStairLanding } from '@aec/building/types';

type LayoutInput = Pick<SteelStairElement, 'start' | 'angle' | 'width' | 'riserCount' | 'riserHeight' | 'going' | 'landings'>;

/** Section sizes in document units that the layout needs (they depend on the unit, so the caller converts). */
export interface StairSizes {
  /** Stringer web thickness. */
  readonly stringerWeb: number;
  /** Stringer section depth. */
  readonly stringerDepth: number;
}

export interface StairRun {
  readonly from: Vec3;
  readonly to: Vec3;
}

/** A tread or landing: plan corners (counter-clockwise from the front-left) and the top height, level-relative. */
export interface StairPlate {
  readonly corners: ReadonlyArray<Vec2>;
  readonly top: number;
  /** Extent along the climb direction. */
  readonly depth: number;
}

export interface StairFlight {
  /** First and last riser of the flight (from 1). */
  readonly firstRiser: number;
  readonly lastRiser: number;
}

export interface StairLayout {
  /** Station s_i of riser i, index i - 1. */
  readonly stations: ReadonlyArray<number>;
  readonly flights: ReadonlyArray<StairFlight>;
  /** Stringer centre-lines: two per flight (left, right of the climb direction). */
  readonly stringers: ReadonlyArray<StairRun>;
  readonly treads: ReadonlyArray<StairPlate>;
  /** Riser each tread tops, same order as `treads`. */
  readonly treadRisers: ReadonlyArray<number>;
  readonly landings: ReadonlyArray<StairPlate>;
  /** Plan length from the first to the last riser. */
  readonly run: number;
}

/** Landings sorted by riser; the flights they delimit. */
export function stairFlights(riserCount: number, landings: ReadonlyArray<SteelStairLanding>): StairFlight[] {
  const cuts = [...landings].map((landing) => landing.afterRiser).sort((a, b) => a - b);
  const flights: StairFlight[] = [];
  let first = 1;
  for (const cut of [...cuts, riserCount]) {
    flights.push({ firstRiser: first, lastRiser: cut });
    first = cut + 1;
  }
  return flights;
}

/** Plan frame of a stair: the climb direction and its left normal. */
export const directionOf = (angle: number): { forward: Vec2; left: Vec2 } => ({
  forward: [Math.cos(angle), Math.sin(angle)],
  left: [-Math.sin(angle), Math.cos(angle)],
});

/** Distance from the stair axis to the stringer centre-line. */
export const stringerOffset = (width: number, sizes: StairSizes): number => width / 2 + sizes.stringerWeb / 2;

export function layoutSteelStair(stair: LayoutInput, sizes: StairSizes): StairLayout {
  const [sx, sy, sz] = stair.start;
  const { forward, left } = directionOf(stair.angle);
  const { riserCount: count, riserHeight: h, going: g } = stair;
  const lengthAfter = new Map(stair.landings.map((landing) => [landing.afterRiser, landing.length]));
  const stations: number[] = [0];
  for (let riser = 1; riser < count; riser++) stations.push((stations[riser - 1] as number) + (lengthAfter.get(riser) ?? g));
  const at = (station: number, side: number, height: number): Vec3 => [
    sx + forward[0] * station + left[0] * side,
    sy + forward[1] * station + left[1] * side,
    sz + height,
  ];
  const plan = (station: number, side: number): Vec2 => [at(station, side, 0)[0], at(station, side, 0)[1]];
  const station = (riser: number): number => stations[riser - 1] as number;

  const flights = stairFlights(count, stair.landings);
  const offset = stringerOffset(stair.width, sizes);
  const drop = sizes.stringerDepth / 2 / Math.cos(Math.atan2(h, g));
  const stringers: StairRun[] = flights.flatMap((flight) =>
    [offset, -offset].map(
      (side): StairRun => ({
        from: at(station(flight.firstRiser), side, flight.firstRiser * h - drop),
        to: at(station(flight.lastRiser), side, flight.lastRiser * h - drop),
      }),
    ),
  );

  const half = stair.width / 2;
  const plate = (riser: number, depth: number): StairPlate => {
    const [from, to] = [station(riser), station(riser) + depth];
    return { corners: [plan(from, -half), plan(to, -half), plan(to, half), plan(from, half)], top: sz + riser * h, depth };
  };
  const treads: StairPlate[] = [];
  const treadRisers: number[] = [];
  const landings: StairPlate[] = [];
  for (let riser = 1; riser < count; riser++) {
    const length = lengthAfter.get(riser);
    if (length === undefined) {
      treads.push(plate(riser, g));
      treadRisers.push(riser);
    } else landings.push(plate(riser, length));
  }
  return { stations, flights, stringers, treads, treadRisers, landings, run: station(count) };
}

/**
 * Handrail path of one side (`side` = +1 left, -1 right of the climb direction) on the nosing line: every nosing from the first to the last riser
 * and, at a landing, the point where the next flight starts. z is the walking surface above the level.
 */
export function handrailPath(stair: LayoutInput, sizes: StairSizes, side: 1 | -1): Vec3[] {
  const { forward, left } = directionOf(stair.angle);
  const offset = side * stringerOffset(stair.width, sizes);
  const lengthAfter = new Map(stair.landings.map((landing) => [landing.afterRiser, landing.length]));
  const point = (station: number, height: number): Vec3 => [
    stair.start[0] + forward[0] * station + left[0] * offset,
    stair.start[1] + forward[1] * station + left[1] * offset,
    stair.start[2] + height,
  ];
  const path: Vec3[] = [];
  let station = 0;
  for (let riser = 1; riser <= stair.riserCount; riser++) {
    path.push(point(station, riser * stair.riserHeight));
    const landing = lengthAfter.get(riser);
    if (landing !== undefined) path.push(point(station + landing, riser * stair.riserHeight));
    station += landing ?? stair.going;
  }
  return path;
}
