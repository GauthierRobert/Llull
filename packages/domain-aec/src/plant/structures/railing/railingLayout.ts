/**
 * Layout of a railing (06 STA §5.3): post stations, rail and toe-plate runs and gates along the path. Pure geometry in document units,
 * z relative to the level; rail depth and toe-plate thickness are passed in because they depend on the unit.
 */

import type { Vec3 } from '@core/model/types';
import type { RailingElement, RailingOpening } from '@aec/building/types';

/** A straight run of rail (centreline), a toe plate (bottom edge centre) or a gate rail. */
export interface RailRun {
  readonly from: Vec3;
  readonly to: Vec3;
}

export interface TopRun extends RailRun {
  /** Height of the rail centreline above the walking surface. */
  readonly centre: number;
}

export interface RailingLayout {
  /** Length of the path (3D, along the polyline). */
  readonly length: number;
  /** Post base points on the walking surface. */
  readonly posts: ReadonlyArray<Vec3>;
  /** Post length, base to the top-rail centreline. */
  readonly postLength: number;
  /** Rails between posts, one run per rail level and bay (index 0 = top rail, 1.. = knee rails downwards). */
  readonly rails: ReadonlyArray<TopRun & { readonly level: number }>;
  /** Rails of the closed gates (same levels as the rails). */
  readonly gates: ReadonlyArray<TopRun & { readonly level: number; readonly opening: number }>;
  readonly toePlates: ReadonlyArray<RailRun>;
  /** Clear space between consecutive rails, the toe plate and the top rail (equal for every gap). */
  readonly clearGap: number;
  /** Rail centreline heights, top rail first. */
  readonly railCentres: ReadonlyArray<number>;
}

const EPSILON = 1e-9;

/** Cumulative 3D length at every path vertex. */
export function cumulativeLengths(path: ReadonlyArray<Vec3>): number[] {
  const lengths = [0];
  for (let index = 1; index < path.length; index++) {
    const [a, b] = [path[index - 1] as Vec3, path[index] as Vec3];
    lengths.push((lengths[index - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return lengths;
}

/** Point at distance `s` along the path. */
export function pointAlong(path: ReadonlyArray<Vec3>, cumulative: ReadonlyArray<number>, s: number): Vec3 {
  let index = 1;
  while (index < path.length - 1 && (cumulative[index] as number) < s) index++;
  const [a, b] = [path[index - 1] as Vec3, path[index] as Vec3];
  const [from, to] = [cumulative[index - 1] as number, cumulative[index] as number];
  const t = to - from <= 0 ? 0 : Math.min(1, Math.max(0, (s - from) / (to - from)));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Post stations: ends, corners, opening ends, and equal spacing <= `spacingMax` inside every interval between them. */
export function postStations(cumulative: ReadonlyArray<number>, openings: ReadonlyArray<RailingOpening>, spacingMax: number): number[] {
  const total = cumulative[cumulative.length - 1] as number;
  const breaks = [...cumulative, ...openings.flatMap((opening) => [opening.from, opening.to])].sort((a, b) => a - b);
  const unique = breaks.filter((value, index) => index === 0 || value - (breaks[index - 1] as number) > EPSILON * Math.max(1, total));
  const stations: number[] = [unique[0] as number];
  for (let index = 1; index < unique.length; index++) {
    const [from, to] = [unique[index - 1] as number, unique[index] as number];
    const bays = Math.max(1, Math.ceil((to - from) / spacingMax - 1e-9));
    for (let bay = 1; bay <= bays; bay++) stations.push(from + ((to - from) * bay) / bays);
  }
  return stations;
}

/**
 * Rail centreline heights (top rail first) and the clear gap between rails for `kneeRails` knee rails, a toe plate of height `toe` and rails of
 * depth `depth`: (height - toe - (k + 1) depth) / (k + 1). The gap is <= 0 when the rails do not fit.
 */
export function railLevels(height: number, kneeRails: number, toe: number, depth: number): { centres: number[]; gap: number } {
  const rails = kneeRails + 1;
  const gap = (height - toe - rails * depth) / rails;
  const centres = Array.from({ length: rails }, (_, index) => toe + (rails - index) * gap + (rails - index - 0.5) * depth);
  return { centres, gap };
}

/** Distance ranges of the path that are open (no rails, no toe plate). */
const isOpen = (openings: ReadonlyArray<RailingOpening>, from: number, to: number): number => {
  const middle = (from + to) / 2;
  return openings.findIndex((opening) => middle > opening.from && middle < opening.to);
};

export function layoutRailing(
  railing: Pick<RailingElement, 'path' | 'height' | 'kneeRails' | 'toePlate' | 'openings' | 'postSpacingMax'>,
  railDepth: number,
): RailingLayout {
  const cumulative = cumulativeLengths(railing.path);
  const length = cumulative[cumulative.length - 1] as number;
  const stations = postStations(cumulative, railing.openings, railing.postSpacingMax);
  const points = stations.map((station) => pointAlong(railing.path, cumulative, station));
  const { centres, gap } = railLevels(railing.height, railing.kneeRails, railing.toePlate, railDepth);
  const [first, last] = [railing.path[0] as Vec3, railing.path[railing.path.length - 1] as Vec3];
  const closed = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) <= EPSILON * Math.max(1, length);
  const lifted = (point: Vec3, rise: number): Vec3 => [point[0], point[1], point[2] + rise];
  const rails: Array<TopRun & { level: number }> = [];
  const gates: Array<TopRun & { level: number; opening: number }> = [];
  const toePlates: RailRun[] = [];
  for (let index = 1; index < stations.length; index++) {
    const [a, b] = [points[index - 1] as Vec3, points[index] as Vec3];
    const opening = isOpen(railing.openings, stations[index - 1] as number, stations[index] as number);
    if (opening >= 0) {
      if (railing.openings[opening]?.gate === true)
        centres.forEach((centre, level) => gates.push({ from: lifted(a, centre), to: lifted(b, centre), centre, level, opening }));
      continue;
    }
    centres.forEach((centre, level) => rails.push({ from: lifted(a, centre), to: lifted(b, centre), centre, level }));
    if (railing.toePlate > 0) toePlates.push({ from: lifted(a, railing.toePlate / 2), to: lifted(b, railing.toePlate / 2) });
  }
  return {
    length,
    posts: closed ? points.slice(0, -1) : points,
    postLength: railing.height - railDepth / 2,
    rails,
    gates,
    toePlates,
    clearGap: gap,
    railCentres: centres,
  };
}

/** Path distance ranges covered by guard: the whole path except the openings that have no gate. */
export function guardedRanges(length: number, openings: ReadonlyArray<RailingOpening>): Array<readonly [number, number]> {
  const gaps = openings
    .filter((opening) => !opening.gate)
    .map((opening): readonly [number, number] => [opening.from, opening.to])
    .sort((a, b) => a[0] - b[0]);
  const ranges: Array<readonly [number, number]> = [];
  let cursor = 0;
  for (const [from, to] of gaps) {
    if (from > cursor) ranges.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < length) ranges.push([cursor, length]);
  return ranges;
}

/** Straight pieces of the path that are guarded (all of it except ungated openings), as end point pairs. */
export function guardedSegments(path: ReadonlyArray<Vec3>, openings: ReadonlyArray<RailingOpening>): Array<readonly [Vec3, Vec3]> {
  const cumulative = cumulativeLengths(path);
  const length = cumulative[cumulative.length - 1] as number;
  return guardedRanges(length, openings).flatMap(([from, to]) => {
    const distances = [from, ...cumulative.filter((value) => value > from + EPSILON && value < to - EPSILON), to];
    return distances
      .slice(1)
      .map((distance, index): readonly [Vec3, Vec3] => [
        pointAlong(path, cumulative, distances[index] as number),
        pointAlong(path, cumulative, distance),
      ]);
  });
}
