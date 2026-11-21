/**
 * Layout of a steel stringer stair (06 STA §5.2). Stations run along the path of the climb: riser i stands at s_i (s_1 = 0), its tread top is at
 * i x riserHeight and spans s_i .. s_(i+1); a landing after riser k widens that span to the landing length. Every flight has its own plan frame
 * (origin, direction, station shift): a straight landing keeps the frame, a quarter-turn landing turns it 90 degrees (the next flight leaves
 * through the side edge, flush with the far edge of the landing), a half-turn landing turns it 180 degrees (the next flight returns beside this
 * one, `HALF_TURN_GAP_WEBS` stringer webs apart, from the near edge of the landing, which spans both flights). Pure geometry in document units,
 * z relative to the level.
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type { SteelStairElement, SteelStairLanding, SteelStairTurn } from '@aec/building/types';

type LayoutInput = Pick<SteelStairElement, 'start' | 'angle' | 'width' | 'riserCount' | 'riserHeight' | 'going' | 'landings'>;

/** Section sizes in document units that the layout needs (they depend on the unit, so the caller converts). */
export interface StairSizes {
  /** Stringer web thickness. */
  readonly stringerWeb: number;
  /** Stringer section depth. */
  readonly stringerDepth: number;
}

/** Clear gap between the two flights of a half-turn stair, in stringer webs. */
const HALF_TURN_GAP_WEBS = 4;

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

/** Plan frame of one flight: the foot of its first riser, its climb direction and the path station of that riser. */
export interface StairFrame {
  readonly origin: Vec2;
  readonly angle: number;
  readonly shift: number;
}

/** A plan rectangle in a frame: path stations `from`..`to` along, `across` = [min, max] sideways from the axis (+ left). */
export interface StairRegion {
  readonly frame: StairFrame;
  readonly from: number;
  readonly to: number;
  readonly across: readonly [number, number];
}

export interface StairLayout {
  /** Station s_i of riser i, index i - 1. */
  readonly stations: ReadonlyArray<number>;
  readonly flights: ReadonlyArray<StairFlight>;
  /** Frame of each flight, same order as `flights`. */
  readonly frames: ReadonlyArray<StairFrame>;
  /** Frame of the flight that riser i belongs to, index i - 1. */
  readonly riserFrames: ReadonlyArray<StairFrame>;
  /** Stringer centre-lines: two per flight (left, right of the climb direction). */
  readonly stringers: ReadonlyArray<StairRun>;
  readonly treads: ReadonlyArray<StairPlate>;
  /** Riser each tread tops, same order as `treads`. */
  readonly treadRisers: ReadonlyArray<number>;
  readonly landings: ReadonlyArray<StairPlate>;
  /** Plan footprint as rectangles: one for a straight stair, else one per flight run and per turn landing. */
  readonly regions: ReadonlyArray<StairRegion>;
  /** Path length from the first to the last riser. */
  readonly run: number;
  /** Plan point of the last riser (the top of the stair). */
  readonly end: Vec2;
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

/** Plan point at path station `station`, `side` to the left of the axis, in `frame`. */
export function framePoint(frame: StairFrame, station: number, side: number): Vec2 {
  const { forward, left } = directionOf(frame.angle);
  const along = station - frame.shift;
  return [frame.origin[0] + forward[0] * along + left[0] * side, frame.origin[1] + forward[1] * along + left[1] * side];
}

/** +1 for a left turn, -1 for a right turn. */
const turnSign = (turn: SteelStairTurn): 1 | -1 => (turn.endsWith('left') ? 1 : -1);
const isHalf = (turn: SteelStairTurn): boolean => turn.startsWith('half');

/** Sideways distance between the axes of the two flights of a half-turn stair. */
const halfTurnAxes = (width: number, sizes: StairSizes): number => width + HALF_TURN_GAP_WEBS * sizes.stringerWeb;

/** Frame of the flight after `landing`, which follows the riser at path station `at` of the flight in `frame`. */
function nextFrame(frame: StairFrame, landing: SteelStairLanding, at: number, width: number, sizes: StairSizes): StairFrame {
  const turn = landing.turn;
  if (turn === undefined) return frame;
  const shift = at + landing.length;
  const sign = turnSign(turn);
  if (isHalf(turn)) return { origin: framePoint(frame, at, sign * halfTurnAxes(width, sizes)), angle: frame.angle + Math.PI, shift };
  return { origin: framePoint(frame, shift - width / 2, (sign * width) / 2), angle: frame.angle + (sign * Math.PI) / 2, shift };
}

/** Sideways extent [min, max] of a landing (a straight or quarter-turn landing: the stair width; a half turn spans both flights). */
function landingAcross(turn: SteelStairTurn | undefined, width: number, sizes: StairSizes): readonly [number, number] {
  if (turn === undefined || !isHalf(turn)) return [-width / 2, width / 2];
  const axes = halfTurnAxes(width, sizes);
  return turnSign(turn) === 1 ? [-width / 2, axes + width / 2] : [-axes - width / 2, width / 2];
}

type Path = Pick<StairLayout, 'stations' | 'flights' | 'frames' | 'riserFrames' | 'run' | 'end'>;

/** Stations, flights and frames of a stair: what every consumer of the plan needs, without the plates. */
function pathOf(stair: LayoutInput, sizes: StairSizes): Path {
  const lengthAfter = new Map(stair.landings.map((landing) => [landing.afterRiser, landing.length]));
  const landingAfter = new Map(stair.landings.map((landing) => [landing.afterRiser, landing]));
  const stations: number[] = [0];
  for (let riser = 1; riser < stair.riserCount; riser++)
    stations.push((stations[riser - 1] as number) + (lengthAfter.get(riser) ?? stair.going));
  const flights = stairFlights(stair.riserCount, stair.landings);
  let frame: StairFrame = { origin: [stair.start[0], stair.start[1]], angle: stair.angle, shift: 0 };
  const frames: StairFrame[] = [];
  const riserFrames: StairFrame[] = [];
  for (const flight of flights) {
    frames.push(frame);
    for (let riser = flight.firstRiser; riser <= flight.lastRiser; riser++) riserFrames.push(frame);
    const landing = landingAfter.get(flight.lastRiser);
    if (landing !== undefined) frame = nextFrame(frame, landing, stations[flight.lastRiser - 1] as number, stair.width, sizes);
  }
  const run = stations[stair.riserCount - 1] as number;
  return { stations, flights, frames, riserFrames, run, end: framePoint(frame, run, 0) };
}

/** Plan point of the top of the stair (the last riser). */
export const stairEnd = (stair: LayoutInput, sizes: StairSizes): Vec2 => pathOf(stair, sizes).end;

export function layoutSteelStair(stair: LayoutInput, sizes: StairSizes): StairLayout {
  const sz = stair.start[2];
  const { riserCount: count, riserHeight: h, going: g } = stair;
  const path = pathOf(stair, sizes);
  const { stations, flights, frames, riserFrames } = path;
  const lengthAfter = new Map(stair.landings.map((landing) => [landing.afterRiser, landing.length]));
  const turnAfter = new Map(stair.landings.map((landing) => [landing.afterRiser, landing.turn]));
  const station = (riser: number): number => stations[riser - 1] as number;
  const at = (frame: StairFrame, along: number, side: number, height: number): Vec3 => {
    const [x, y] = framePoint(frame, along, side);
    return [x, y, sz + height];
  };

  const offset = stringerOffset(stair.width, sizes);
  const drop = sizes.stringerDepth / 2 / Math.cos(Math.atan2(h, g));
  const stringers: StairRun[] = flights.flatMap((flight, index) =>
    [offset, -offset].map(
      (side): StairRun => ({
        from: at(frames[index] as StairFrame, station(flight.firstRiser), side, flight.firstRiser * h - drop),
        to: at(frames[index] as StairFrame, station(flight.lastRiser), side, flight.lastRiser * h - drop),
      }),
    ),
  );

  const half = stair.width / 2;
  const plate = (riser: number, depth: number, across: readonly [number, number] = [-half, half]): StairPlate => {
    const [from, to] = [station(riser), station(riser) + depth];
    const frame = riserFrames[riser - 1] as StairFrame;
    const plan = (along: number, side: number): Vec2 => framePoint(frame, along, side);
    return {
      corners: [plan(from, across[0]), plan(to, across[0]), plan(to, across[1]), plan(from, across[1])],
      top: sz + riser * h,
      depth,
    };
  };
  const treads: StairPlate[] = [];
  const treadRisers: number[] = [];
  const landings: StairPlate[] = [];
  for (let riser = 1; riser < count; riser++) {
    const length = lengthAfter.get(riser);
    if (length === undefined) {
      treads.push(plate(riser, g));
      treadRisers.push(riser);
    } else landings.push(plate(riser, length, landingAcross(turnAfter.get(riser), stair.width, sizes)));
  }

  const regions: StairRegion[] = [];
  let from = 0;
  flights.forEach((flight, index) => {
    const turn = turnAfter.get(flight.lastRiser);
    if (turn === undefined) return;
    const [end, length] = [station(flight.lastRiser), lengthAfter.get(flight.lastRiser) as number];
    const frame = frames[index] as StairFrame;
    regions.push({ frame, from, to: end, across: [-half, half] });
    regions.push({ frame, from: end, to: end + length, across: landingAcross(turn, stair.width, sizes) });
    from = end + length;
  });
  regions.push({ frame: frames[frames.length - 1] as StairFrame, from, to: path.run, across: [-half, half] });
  return { ...path, stringers, treads, treadRisers, landings, regions };
}

/**
 * Handrail path of one side (`side` = +1 left, -1 right of the climb direction) on the nosing line: every nosing from the first to the last riser
 * and, at a landing, the point where the next flight starts; at a turn the rail follows the landing to the same-side rail of the next flight (one
 * corner at a quarter turn, two at a half turn). z is the walking surface above the level.
 */
export function handrailPath(stair: LayoutInput, sizes: StairSizes, side: 1 | -1): Vec3[] {
  const { stations, riserFrames } = pathOf(stair, sizes);
  const offset = side * stringerOffset(stair.width, sizes);
  const landingAfter = new Map(stair.landings.map((landing) => [landing.afterRiser, landing]));
  const point = (frame: StairFrame, along: number, across: number, height: number): Vec3 => {
    const [x, y] = framePoint(frame, along, across);
    return [x, y, stair.start[2] + height];
  };
  const path: Vec3[] = [];
  for (let riser = 1; riser <= stair.riserCount; riser++) {
    const frame = riserFrames[riser - 1] as StairFrame;
    const here = stations[riser - 1] as number;
    const height = riser * stair.riserHeight;
    path.push(point(frame, here, offset, height));
    const landing = landingAfter.get(riser);
    if (landing === undefined) continue;
    const beyond = here + landing.length;
    const turn = landing.turn;
    if (turn === undefined) path.push(point(frame, beyond, offset, height));
    else if (isHalf(turn)) {
      path.push(point(frame, beyond, offset, height));
      path.push(point(frame, beyond, turnSign(turn) * halfTurnAxes(stair.width, sizes) - offset, height));
    } else path.push(point(frame, beyond - stair.width / 2 - turnSign(turn) * offset, offset, height));
  }
  return path;
}
