/**
 * Load of the flights of steel stairs (treads + stringers + imposed) carried to the beams under the stringer ends. Each flight is a pair of
 * stringers simply supported at the foot and at the top of the flight, so under a load uniform per plan length each stringer end takes half of
 * the stringer's share: foot and top of the flight take half of the flight total each, split between the two stringers. A point load of
 * that size acts at the plan point of each stringer end on the nearest beam whose top of steel is in the band under the surface the end rests on.
 */

import type { Vec3 } from '@core/model/types';
import { polygonArea, projectOntoSegment, type Point2 } from '@lib/polygon';
import type { SteelStairElement } from '@aec/building/types';
import { elementsOf } from '../../building/model';
import { GRAVITY } from '../../shared/numeric';
import { findProfile } from '../../steel/profiles';
import {
  framePoint,
  layoutSteelStair,
  stringerOffset,
  type StairFrame,
  type StairFlight,
  type StairLayout,
  type StairSizes,
} from '../../plant/structures/stair/steelStairLayout';
import { stairSizes, treadMassKgM2, treadThickness } from '../../plant/structures/stair/steelStairMeasure';
import { beamsUnder, nearInPlan } from './steelAreaLoads';
import { addPointLoad, type BeamLoads } from './steelBeamLoads';
import type { ModelUnits } from './steelMemberBars';

export interface StairFlightLoadReport {
  /** `<stair id>:flight-<n>`, n from 1 at the bottom. */
  readonly flightId: string;
  readonly mark: string;
  readonly levelId: string;
  /** Plan area of the flight's treads, m². */
  readonly treadAreaM2: number;
  /** Treads + stringers (+ knuckles) of the flight, kN. */
  readonly deadKn: number;
  /** Imposed load x tread plan area, kN. */
  readonly imposedKn: number;
  /** Part of the dead / imposed load that reached a beam, kN (a foot on grade or a top on a surface with no beam is not carried). */
  readonly carriedDeadKn: number;
  readonly carriedImposedKn: number;
  /** Stringer ends (of 4) that bear on a beam. */
  readonly endsOnBeams: number;
  /** Stringer ends that bear on no beam, the foot of the first flight excluded (it may stand on grade): each is warned. */
  readonly unsupportedEnds: number;
}

interface FlightLoadResult {
  readonly flights: StairFlightLoadReport[];
  readonly warnings: string[];
}

const END_SHARE = 0.5;

const mmOf = (run: { readonly from: Vec3; readonly to: Vec3 }): number =>
  Math.hypot(run.to[0] - run.from[0], run.to[1] - run.from[1], run.to[2] - run.from[2]);

/** Put `permanent` / `imposed` kN on the beam nearest in plan to `point` among those under the surface at `top` (mm); false when there is none. */
function bearOnBeam(
  beams: ReadonlyArray<BeamLoads>,
  point: Point2,
  top: number,
  thickness: number,
  margin: number,
  loads: [number, number],
): boolean {
  const near = nearInPlan(beamsUnder(beams, top - thickness, top), [point], margin);
  let best: { beam: BeamLoads; t: number; distance: number } | undefined;
  for (const beam of near) {
    const hit = projectOntoSegment(point, beam.a, beam.b);
    if (best === undefined || hit.distance < best.distance) best = { beam, t: hit.t, distance: hit.distance };
  }
  if (best === undefined) return false;
  addPointLoad(best.beam, best.t * best.beam.lengthM * 1000, loads[0], loads[1], true);
  return true;
}

interface FlightContext {
  readonly units: ModelUnits;
  readonly beams: ReadonlyArray<BeamLoads>;
  readonly stair: SteelStairElement;
  readonly layout: StairLayout;
  readonly sizes: StairSizes;
  readonly imposedKPa: number;
}

function flightReport(context: FlightContext, index: number): StairFlightLoadReport {
  const { units, beams, stair, layout, sizes } = context;
  const { toMm, elevationMm, source } = units;
  const flight = layout.flights[index] as StairFlight;
  const mmToM = toMm(1) / 1000;
  const area =
    layout.treads.reduce((sum, plate, at) => {
      const riser = layout.treadRisers[at] as number;
      return riser >= flight.firstRiser && riser <= flight.lastRiser ? sum + polygonArea([...plate.corners]) : sum;
    }, 0) *
    mmToM *
    mmToM;
  const stringerM =
    (layout.stringers.slice(2 * index, 2 * index + 2).reduce((sum, run) => sum + mmOf(run), 0) +
      layout.knuckles.reduce((sum, run, at) => (layout.knuckleFlights[at] === index ? sum + mmOf(run) : sum), 0)) *
    mmToM;
  const profile = findProfile(stair.stringerProfile);
  const deadKn =
    ((area * treadMassKgM2(source, stair.tread) + stringerM * (profile === undefined ? 0 : profile.massPerMetre)) * GRAVITY) / 1000;
  const imposedKn = context.imposedKPa * area;
  const thickness = toMm(treadThickness(source, stair.tread));
  const margin = toMm(sizes.stringerDepth);
  const frame = layout.frames[index] as StairFrame;
  const offset = stringerOffset(stair.width, sizes);
  const ends = [
    { riser: flight.firstRiser, height: (flight.firstRiser - 1) * stair.riserHeight },
    { riser: flight.lastRiser, height: flight.lastRiser * stair.riserHeight },
  ];
  let carried = 0;
  let onBeams = 0;
  let unsupported = 0;
  for (const end of ends) {
    const top = elevationMm(stair.levelId) + toMm(stair.start[2] + end.height);
    for (const side of [offset, -offset]) {
      const [x, y] = framePoint(frame, layout.stations[end.riser - 1] as number, side);
      const share = END_SHARE / 2;
      if (bearOnBeam(beams, [toMm(x), toMm(y)], top, thickness, margin, [deadKn * share, imposedKn * share])) {
        carried += share;
        onBeams += 1;
      } else if (index > 0 || end.riser !== flight.firstRiser) unsupported += 1;
    }
  }
  return {
    flightId: `${stair.id}:flight-${index + 1}`,
    mark: stair.mark,
    levelId: stair.levelId,
    treadAreaM2: area,
    deadKn,
    imposedKn,
    carriedDeadKn: deadKn * carried,
    carriedImposedKn: imposedKn * carried,
    endsOnBeams: onBeams,
    unsupportedEnds: unsupported,
  };
}

/**
 * Flights of every steel stair as point loads on the beams under their stringer ends; nothing without a cited imposed load.
 * @invariant carried load = flight load x (stringer ends on a beam) / 4; the foot of the first flight is not warned (it may stand on grade)
 */
export function applyStairFlightLoads(
  units: ModelUnits,
  beams: ReadonlyArray<BeamLoads>,
  load: { readonly imposedKPa: number } | undefined,
): FlightLoadResult {
  const flights: StairFlightLoadReport[] = [];
  const warnings: string[] = [];
  if (load === undefined) return { flights, warnings };
  for (const stair of elementsOf(units.building, 'steelStair')) {
    const sizes = stairSizes(units.source, stair);
    const context: FlightContext = { units, beams, stair, layout: layoutSteelStair(stair, sizes), sizes, imposedKPa: load.imposedKPa };
    context.layout.flights.forEach((_, index) => {
      const report = flightReport(context, index);
      flights.push(report);
      if (report.unsupportedEnds > 0)
        warnings.push(
          `steel stair ${stair.mark} flight ${index + 1}: ${report.unsupportedEnds} stringer end(s) bear on no beam at their level; that part of the flight load is not carried by any member`,
        );
    });
  }
  return { flights, warnings };
}
