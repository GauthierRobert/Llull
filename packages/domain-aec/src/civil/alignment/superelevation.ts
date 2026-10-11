/**
 * Superelevation: the cross slope of each carriageway side along an alignment. Normal crown on
 * tangents; per curve, the adverse (outer) side runs out to flat and on to the full rate at a constant
 * rotation rate, then the whole section tilts as one plane about the centreline, outer side raised.
 * Entry / exit ramps end at the SC / CS (spiral) or 30 % of the runoff into the circle (no spiral).
 * Slopes are ratios "falling away from the centreline" (negative = rising).
 * @layer domain-aec/civil
 * @pure
 */

import type { AlignmentObject } from '@core/model/civil';
import { horizontalElements, type HorizontalElement } from './alignmentGeometry';

/** Relative gradient of the pavement edge used for the runoff length when no spiral gives one. */
export const MAX_RELATIVE_GRADIENT = 0.005;
/** Share of an unspiralled runoff that lies inside the circular curve. */
const RUNOFF_IN_CURVE = 0.3;

export interface CrossSlopes {
  /** Fall of the left side (travel direction) away from the centreline. */
  readonly left: number;
  /** Fall of the right side away from the centreline. */
  readonly right: number;
}

interface CurveRamps {
  readonly turn: 1 | -1;
  readonly fullIn: number;
  readonly fullOut: number;
  readonly runoffIn: number;
  readonly runoffOut: number;
}

/** Whether the alignment carries a usable superelevation design. */
export function hasSuperelevation(alignment: AlignmentObject): boolean {
  return (alignment.superelevation?.maxRate ?? 0) > 0;
}

function groupByCurve(elements: ReadonlyArray<HorizontalElement>): HorizontalElement[][] {
  const groups: HorizontalElement[][] = [];
  for (const element of elements) {
    if (element.kind === 'line') continue;
    const last = groups[groups.length - 1];
    const previous = last?.[last.length - 1];
    const sameCurve =
      previous !== undefined && previous.kind !== 'line' && previous.pi === element.pi;
    if (last && sameCurve) last.push(element);
    else groups.push([element]);
  }
  return groups;
}

function rampsOf(
  group: ReadonlyArray<HorizontalElement>,
  fallbackRunoff: number,
  runoffLength: number | undefined,
): CurveRamps | null {
  let entry: HorizontalElement | undefined;
  let exit: HorizontalElement | undefined;
  let arc: HorizontalElement | undefined;
  for (const element of group) {
    if (element.kind === 'arc') arc = element;
    else if (element.kind === 'spiral' && element.radiusStart === Infinity) entry = element;
    else if (element.kind === 'spiral') exit = element;
  }
  const first = group[0];
  if (!first || first.kind === 'line') return null;
  const turn = first.rotation === 'ccw' ? 1 : -1;
  const arcShare = arc
    ? Math.min(RUNOFF_IN_CURVE * (runoffLength ?? fallbackRunoff), arc.length / 2)
    : 0;
  const runoffIn = runoffLength ?? entry?.length ?? fallbackRunoff;
  const runoffOut = runoffLength ?? exit?.length ?? fallbackRunoff;
  return {
    turn,
    fullIn: entry ? entry.startStation + entry.length : (arc?.startStation ?? 0) + arcShare,
    fullOut: exit ? exit.startStation : (arc ? arc.startStation + arc.length : 0) - arcShare,
    runoffIn,
    runoffOut,
  };
}

/** Outer-side fall at `station` for one curve (`crossfall` on the normal crown, down to `-full`). */
function outerFall(ramps: CurveRamps, station: number, crossfall: number, full: number): number {
  const entering = -full + (full * (ramps.fullIn - station)) / ramps.runoffIn;
  const leaving = -full + (full * (station - ramps.fullOut)) / ramps.runoffOut;
  return Math.min(Math.max(entering, leaving, -full), crossfall);
}

/**
 * Cross slopes of both carriageway sides at each requested station. `crossfall` is the normal crown
 * and `laneWidth` sizes the relative-gradient runoff of curves without a spiral. Without a
 * superelevation design the result is the normal crown everywhere.
 */
export function crossSlopesAt(
  alignment: AlignmentObject,
  crossfall: number,
  laneWidth: number,
  station: number,
): CrossSlopes {
  const crown: CrossSlopes = { left: crossfall, right: crossfall };
  const design = alignment.superelevation;
  if (!design || !(design.maxRate > 0)) return crown;
  const full = Math.max(design.maxRate, crossfall);
  const fallback = (full * laneWidth) / MAX_RELATIVE_GRADIENT;
  let outer = crossfall;
  let turn: 1 | -1 = 1;
  for (const group of groupByCurve(horizontalElements(alignment))) {
    const ramps = rampsOf(group, fallback, design.runoffLength);
    if (!ramps) continue;
    const fall = outerFall(ramps, station, crossfall, full);
    if (fall < outer) {
      outer = fall;
      turn = ramps.turn;
    }
  }
  if (outer >= crossfall) return crown;
  const inner = outer >= -crossfall ? crossfall : -outer;
  return turn === 1 ? { left: inner, right: outer } : { left: outer, right: inner };
}

/**
 * Signed superelevation rate: (left fall - right fall) / 2. Positive = banked for a left-hand curve
 * (section falls to the left), negative = right-hand, 0 on the normal crown.
 */
export function superelevationRate(slopes: CrossSlopes): number {
  return (slopes.left - slopes.right) / 2;
}

/** Stations where the cross slope changes slope: the runout start, flat points and full-rate points. */
export function superelevationStations(
  alignment: AlignmentObject,
  crossfall: number,
  laneWidth: number,
): number[] {
  const design = alignment.superelevation;
  if (!design || !(design.maxRate > 0)) return [];
  const full = Math.max(design.maxRate, crossfall);
  const fallback = (full * laneWidth) / MAX_RELATIVE_GRADIENT;
  const stations: number[] = [];
  for (const group of groupByCurve(horizontalElements(alignment))) {
    const ramps = rampsOf(group, fallback, design.runoffLength);
    if (!ramps) continue;
    const flatIn = ramps.fullIn - ramps.runoffIn;
    const flatOut = ramps.fullOut + ramps.runoffOut;
    const runout = (crossfall * ramps.runoffIn) / full;
    const runoutOut = (crossfall * ramps.runoffOut) / full;
    stations.push(
      ramps.fullIn,
      ramps.fullOut,
      flatIn,
      flatIn - runout,
      flatIn + runout,
      flatOut,
      flatOut + runoutOut,
      flatOut - runoutOut,
    );
  }
  return stations;
}
