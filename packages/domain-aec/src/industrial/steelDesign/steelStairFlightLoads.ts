/**
 * Load of the flights of steel stairs (treads + stringers + imposed) carried to the beams under the stringer ends. Each flight is a pair of
 * stringers simply supported at the foot and at the top of the flight, so under a load uniform per plan length each stringer end takes half of
 * the stringer's share: foot and top of the flight take half of the flight total each, split between the two stringers. A point load of
 * that size acts at the plan point of each stringer end on the nearest beam whose top of steel is in the band under the surface the end rests on.
 */

import type { Vec3 } from '@core/model/types';
import { minOf } from '@lib/arrayExtrema';
import { arrivalSurface, walkingSurfaces } from '../../plant/structures/ladder/ladderSurface';
import { findGratingType } from '../../plant/structures/grating/gratingTypes';
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
const TIE = 1e-6;

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
  const hits = near.map((beam) => ({ beam, ...projectOntoSegment(point, beam.a, beam.b) }));
  if (hits.length === 0) return false;
  const nearest = minOf(hits.map((hit) => hit.distance));
  const tied = hits.filter((hit) => hit.distance <= nearest + TIE);
  for (const { beam, t } of tied) addPointLoad(beam, t * beam.lengthM * 1000, loads[0] / tied.length, loads[1] / tied.length, true);
  return true;
}

/** The slab or grating panel an end of the stair rests on (within 50 mm in height, 600 mm in plan), with its thickness / bar depth in mm. */
function surfaceUnder(units: ModelUnits, point: Point2, topMm: number): { id: string; thicknessMm: number } | undefined {
  const unit = 1 / units.toMm(1);
  const found = arrivalSurface(walkingSurfaces(units.building), [point[0] * unit, point[1] * unit], topMm * unit, 50 * unit, 600 * unit);
  const element = found === undefined ? undefined : units.building.elements[found.id];
  if (element?.category === 'slab') return { id: element.id, thicknessMm: units.toMm(element.thickness) };
  const type = element?.category === 'grating' ? findGratingType(element.gratingType) : undefined;
  return element === undefined || type === undefined ? undefined : { id: element.id, thicknessMm: type.barDepthMm };
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
  const lowest = minOf(Object.values(units.building.levels).map((level) => units.elevationMm(level.id)));
  for (const end of ends) {
    const top = elevationMm(stair.levelId) + toMm(stair.start[2] + end.height);
    const resting = end.riser === flight.firstRiser ? index === 0 : index === layout.flights.length - 1;
    for (const side of [offset, -offset]) {
      const [x, y] = framePoint(frame, layout.stations[end.riser - 1] as number, side);
      const point: Point2 = [toMm(x), toMm(y)];
      const surface = resting ? surfaceUnder(units, point, top) : undefined;
      const share = END_SHARE / 2;
      const bears = bearOnBeam(beams, point, top, surface === undefined ? thickness : surface.thicknessMm, margin, [
        deadKn * share,
        imposedKn * share,
      ]);
      if (bears) {
        carried += share;
        onBeams += 1;
      } else if (!(end.riser === flight.firstRiser && index === 0 && (surface === undefined || Math.abs(top - lowest) <= 1)))
        unsupported += 1;
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
 * @invariant carried load = flight load x (stringer ends on a beam) / 4; the foot of the first flight is not warned when it is at the lowest level elevation or no slab / grating lies under it; an end bears on the beams under the slab / grating it rests on (its thickness sets the band), else under the tread; a tie splits the load
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
