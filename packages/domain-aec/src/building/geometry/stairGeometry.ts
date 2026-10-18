/** Stair layout: flights, landing, solid blocks and side profiles in the stair plan frame (`along` the first flight, `across` it, left positive). */

import type { StairElement } from '@core/model/building';
import type { Vec2 } from '@core/model/types';
import { polygonArea } from '@lib/polygon';

/** Plan point `along` the first flight from the stair start and `across` it (left of travel positive). */
export function stairPoint(stair: StairElement, along: number, across: number): Vec2 {
  const [cos, sin] = [Math.cos(stair.angle), Math.sin(stair.angle)];
  return [stair.start[0] + cos * along - sin * across, stair.start[1] + sin * along + cos * across];
}

/** Waist-slab thickness (perpendicular to the flight); stairs saved without one use the riser height (about 150-190 mm). */
function waistOf(stair: StairElement): number {
  return stair.waistThickness ?? stair.riserHeight;
}

/** Vertical distance between the step roots and the sloping soffit. */
function verticalWaistOf(stair: StairElement): number {
  return (waistOf(stair) * Math.hypot(stair.riserHeight, stair.treadDepth)) / stair.treadDepth;
}

/** The landing's riser index when it is valid for this stair (integer, 2 to riserCount - 2), else null (one uninterrupted flight). */
function landingIndex(stair: StairElement): number | null {
  const at = stair.landingAt;
  return at !== undefined && Number.isInteger(at) && at >= 2 && at <= stair.riserCount - 2 ? at : null;
}

/** One straight run of steps. Its local frame: `u` along the flight from its first riser, `v` across (left positive). */
export interface StairFlight {
  /** Middle of the first riser, in the stair plan frame. */
  readonly origin: Vec2;
  /** Direction of travel relative to the stair angle (radians, CCW). */
  readonly heading: number;
  readonly risers: number;
  /** Height of the flight's start above the stair base (0 for the first flight, the landing top for the next). */
  readonly baseZ: number;
  /** Lowest point of the flight, relative to `baseZ` (0 on the floor, minus the waist under the landing). */
  readonly floorZ: number;
  /** Underside of the landing this flight arrives at (relative to `baseZ`) and the depth available for the wedge under it. */
  readonly foot: { readonly bottom: number; readonly length: number } | null;
}

/** The intermediate landing: a horizontal slab. `plan` is a rectangle in the stair plan frame. */
export interface StairLanding {
  readonly plan: Vec2[];
  readonly zBottom: number;
  readonly zTop: number;
}

/** Flight-local point (u along, v across) in the stair plan frame. */
export function flightPoint(flight: StairFlight, u: number, v: number): Vec2 {
  const [cos, sin] = [Math.cos(flight.heading), Math.sin(flight.heading)];
  return [flight.origin[0] + cos * u - sin * v, flight.origin[1] + sin * u + cos * v];
}

function landingExtent(stair: StairElement, at: number): { along: [number, number]; across: [number, number] } {
  const length = stair.landingLength ?? stair.width;
  const start = (at - 1) * stair.treadDepth;
  const half = stair.width / 2;
  if (stair.shape !== 'half_turn') return { along: [start, start + length], across: [-half, half] };
  const offset = (stair.turn === 'right' ? -1 : 1) * (stair.width + (stair.flightGap ?? 0));
  return { along: [start, start + length], across: [Math.min(-half, offset - half), Math.max(half, offset + half)] };
}

/** @returns the landing slab, or null when the stair has none */
export function stairLanding(stair: StairElement): StairLanding | null {
  const at = landingIndex(stair);
  if (at === null) return null;
  const { along, across } = landingExtent(stair, at);
  return {
    plan: [
      [along[0], across[0]],
      [along[1], across[0]],
      [along[1], across[1]],
      [along[0], across[1]],
    ],
    zBottom: Math.max(0, at * stair.riserHeight - waistOf(stair)),
    zTop: at * stair.riserHeight,
  };
}

/**
 * The flights of a stair in climbing order. Without a landing: one flight of `riserCount` risers. With a landing after riser `landingAt`
 * (L): flight 1 has L risers (the L-th arrives on the landing), flight 2 the other `riserCount - L`; the last riser arrives on the upper
 * floor. Flight 2 continues straight (straight), leaves sideways from the far end of the landing (quarter_turn), or doubles back beside
 * flight 1 (half_turn).
 */
export function stairFlights(stair: StairElement): StairFlight[] {
  const at = landingIndex(stair);
  const landing = stairLanding(stair);
  if (at === null || !landing) return [{ origin: [0, 0], heading: 0, risers: stair.riserCount, baseZ: 0, floorZ: 0, foot: null }];
  const { along } = landingExtent(stair, at);
  const side = stair.turn === 'right' ? -1 : 1;
  const half = stair.width / 2;
  const first: StairFlight = {
    origin: [0, 0],
    heading: 0,
    risers: at,
    baseZ: 0,
    floorZ: 0,
    foot: { bottom: landing.zBottom, length: along[1] - along[0] },
  };
  const placement: { origin: Vec2; heading: number } =
    stair.shape === 'quarter_turn'
      ? { origin: [along[1] - half, side * half], heading: (side * Math.PI) / 2 }
      : stair.shape === 'half_turn'
        ? { origin: [along[0], side * (stair.width + (stair.flightGap ?? 0))], heading: Math.PI }
        : { origin: [along[1], 0], heading: 0 };
  return [first, { ...placement, risers: stair.riserCount - at, baseZ: landing.zTop, floorZ: landing.zBottom - landing.zTop, foot: null }];
}

/** Axis-aligned (in the flight or stair frame) solid block: a step or the landing. Heights are relative to the stair base. */
export interface StairBlock {
  /** 0-based flight index, or null for the landing. */
  readonly flight: number | null;
  /** Block centre in the stair plan frame. */
  readonly centre: Vec2;
  /** Direction of the block's length axis relative to the stair angle. */
  readonly heading: number;
  readonly length: number;
  readonly breadth: number;
  readonly zBottom: number;
  readonly zTop: number;
}

/** Block-local offset (alongLength, alongBreadth) from the block centre, in the stair plan frame. */
export function blockPoint(block: StairBlock, alongLength: number, alongBreadth: number): Vec2 {
  const [cos, sin] = [Math.cos(block.heading), Math.sin(block.heading)];
  return [block.centre[0] + cos * alongLength - sin * alongBreadth, block.centre[1] + sin * alongLength + cos * alongBreadth];
}

/** Plan corners of a block in the stair plan frame. */
export function blockCorners(block: StairBlock): Vec2[] {
  const [l, b] = [block.length / 2, block.breadth / 2];
  return [blockPoint(block, -l, -b), blockPoint(block, l, -b), blockPoint(block, l, b), blockPoint(block, -l, b)];
}

/**
 * Solid steps and the landing of a waist-slab stair. A flight with `r` risers has `r - 1` treads (its last riser arrives on the next
 * level or the landing). Each tread is a block from its top down to the sloping soffit at mid-tread, so the solid is the waist slab plus the
 * step wedges (not a solid mass down to the floor).
 * @invariant treads[k].zTop = flight.baseZ + (k + 1) * riserHeight; soffit never below the flight floor
 */
export function stairBlocks(stair: StairElement): StairBlock[] {
  const { riserHeight: rise, treadDepth: going } = stair;
  const verticalWaist = verticalWaistOf(stair);
  const blocks = stairFlights(stair).flatMap((flight, index) =>
    Array.from({ length: Math.max(flight.risers - 1, 0) }, (_, tread): StairBlock => {
      return {
        flight: index,
        centre: flightPoint(flight, (tread + 0.5) * going, 0),
        heading: flight.heading,
        length: going,
        breadth: stair.width,
        zBottom: flight.baseZ + Math.max(flight.floorZ, (tread + 0.5) * rise - verticalWaist),
        zTop: flight.baseZ + (tread + 1) * rise,
      };
    }),
  );
  const landing = stairLanding(stair);
  if (!landing) return blocks;
  const [[x0, y0], , [x1, y1]] = landing.plan as [Vec2, Vec2, Vec2, Vec2];
  return [
    ...blocks,
    {
      flight: null,
      centre: [(x0 + x1) / 2, (y0 + y1) / 2],
      heading: 0,
      length: x1 - x0,
      breadth: y1 - y0,
      zBottom: landing.zBottom,
      zTop: landing.zTop,
    },
  ];
}

/** Bounding rectangle of the whole stair in its plan frame. */
export function stairExtent(stair: StairElement): { minAlong: number; maxAlong: number; minAcross: number; maxAcross: number } {
  const corners = stairBlocks(stair).flatMap(blockCorners);
  const [alongs, acrosses] = [corners.map((corner) => corner[0]), corners.map((corner) => corner[1])];
  return {
    minAlong: Math.min(...alongs),
    maxAlong: Math.max(...alongs),
    minAcross: Math.min(...acrosses),
    maxAcross: Math.max(...acrosses),
  };
}

/**
 * Side profile (along the flight, height above the flight base) of one flight as ONE solid: stepped top, and an underside that is the
 * sloping waist slab. The waist line runs parallel to the pitch and passes `waistThickness` (perpendicular) below the step roots
 * (z = along * rise / going); it is clipped by the flight floor. A flight arriving on a landing carries a wedge under the landing
 * so the soffit meets the landing's underside.
 * @returns counter-clockwise outline; empty when there is no tread
 */
export function flightProfile(stair: StairElement, flight: StairFlight): Vec2[] {
  const { riserHeight: rise, treadDepth: going } = stair;
  const treads = Math.max(flight.risers - 1, 0);
  if (treads === 0) return [];
  const length = treads * going;
  const verticalWaist = verticalWaistOf(stair);
  const soffitAt = (along: number): number => (along * rise) / going - verticalWaist;
  const clampAlong = Math.min(length, Math.max(0, ((flight.floorZ + verticalWaist) * going) / rise));
  const outline: Vec2[] = [[0, flight.floorZ]];
  const push = (point: Vec2): void => {
    const last = outline[outline.length - 1];
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 1e-9) outline.push(point);
  };
  if (clampAlong > 0) push([clampAlong, flight.floorZ]);
  if (clampAlong < length) push([length, soffitAt(length)]);
  const end = Math.max(flight.floorZ, soffitAt(length));
  if (flight.foot && flight.foot.bottom > end) {
    const run = Math.min(flight.foot.length, ((flight.foot.bottom - end) * going) / rise);
    const reached = end + (run * rise) / going;
    push([length + run, reached]);
    push([length + run, flight.foot.bottom]);
    push([length, flight.foot.bottom]);
  }
  push([length, treads * rise]);
  for (let tread = treads - 1; tread >= 0; tread--) {
    push([tread * going, (tread + 1) * rise]);
    if (tread > 0) push([tread * going, tread * rise]);
  }
  return outline;
}

/** Concrete volume of the stair (document units³): each flight's profile area times the width, plus the landing slab. */
export function stairConcreteVolume(stair: StairElement): number {
  const flights = stairFlights(stair).reduce((sum, flight) => sum + polygonArea(flightProfile(stair, flight)) * stair.width, 0);
  const landing = stairLanding(stair);
  if (!landing) return flights;
  const [[x0, y0], , [x1, y1]] = landing.plan as [Vec2, Vec2, Vec2, Vec2];
  return flights + (x1 - x0) * (y1 - y0) * (landing.zTop - landing.zBottom);
}
