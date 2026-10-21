/** Supports at the steel a pipe crosses: arc lengths where the centreline passes over (or under) a member, and the span check after them. */

import type { SteelBar } from '../steelDesign/steelMemberBars';
import type { PipeSupportElement } from '@aec/building/types';
import type { Vec3 } from '@core/model/types';
import { arcLengths, pointAtArc } from './routeSupport';
import type { EndCarrier, PipeRun } from './pipeSupportLayout';
import { isPlaceable } from './pipeSupportPlacement';
import { isRiserPoint, resolveBearing } from './pipeSupportAttach';
import type { BearingLimits } from './pipeSupportMember';

/** Finest / coarsest distance between probe points along the run, mm. */
const MIN_STEP = 25;
const MAX_PROBES = 1500;
/** A stretch bearing on one member longer than this runs alongside it (no single crossing): spacing places supports there instead, mm. */
const MAX_CROSSING = 1500;

/**
 * Arc lengths (mm) at the middle of every stretch where `run` bears on one steel member, ascending: one per member the pipe crosses.
 * @invariant stretches longer than 1.5 m (a member parallel to the pipe) and riser stretches give no arc
 */
export function steelCrossingArcs(
  run: PipeRun,
  bars: ReadonlyArray<SteelBar>,
  type: PipeSupportElement['type'],
  limits: BearingLimits,
  explicit?: SteelBar,
): number[] {
  const step = Math.max(MIN_STEP, run.lengthMm / MAX_PROBES);
  const count = Math.ceil(run.lengthMm / step);
  const crossings: number[] = [];
  let current: { memberId: string; from: number; to: number } | null = null;
  const close = (): void => {
    if (current !== null && current.to - current.from <= MAX_CROSSING) crossings.push((current.from + current.to) / 2);
    current = null;
  };
  for (let index = 0; index <= count; index++) {
    const arc = Math.min(index * step, run.lengthMm);
    const at = pointAtArc(run.points, arc);
    const placeable = at !== null && isPlaceable(run, arc) && !isRiserPoint(run.points, at.point);
    const hit = placeable ? resolveBearing(bars, type, at.point as Vec3, run.diameterMm, limits, false, explicit) : null;
    const memberId = hit !== null && typeof hit !== 'string' ? hit.memberId : null;
    if (memberId === null) close();
    else if (current !== null && current.memberId === memberId) current.to = arc;
    else {
      close();
      current = { memberId, from: arc, to: arc };
    }
  }
  close();
  return crossings;
}

/**
 * Warnings for the support layout `arcs` (mm along the pipe) of `run`: a span longer than the requested spacing or than the table span, and
 * a free end overhanging by more than half the spacing.
 */
export function spanWarnings(
  run: PipeRun,
  arcs: ReadonlyArray<number>,
  carriers: readonly [EndCarrier | null, EndCarrier | null],
  spacingMm: number,
  tableSpanMm: number,
): string[] {
  const length = arcLengths(run.points).at(-1) ?? 0;
  const stations = [...arcs].sort((a, b) => a - b);
  const warnings: string[] = [];
  const mark = run.element.mark;
  const metres = (mm: number): string => `${(Math.round(mm) / 1000).toFixed(2)} m`;
  const stretch = [...(carriers[0] ? [0] : []), ...stations, ...(carriers[1] ? [length] : [])];
  stretch.slice(1).forEach((arc, index) => {
    const span = arc - (stretch[index] as number);
    if (span > tableSpanMm + 1e-6) warnings.push(`${mark} span ${metres(span)} exceeds the table span ${metres(tableSpanMm)}`);
    else if (span > spacingMm + 1e-6) warnings.push(`${mark} span ${metres(span)} exceeds the requested spacing ${metres(spacingMm)}`);
  });
  const ends: Array<[string, number | null, boolean]> = [
    ['start', stations[0] ?? null, carriers[0] === null],
    ['end', stations.length > 0 ? length - (stations.at(-1) as number) : null, carriers[1] === null],
  ];
  for (const [end, overhang, free] of ends) {
    if (free && overhang !== null && overhang > spacingMm / 2 + 1e-6) {
      warnings.push(`${mark} ${end} overhang ${metres(overhang)} exceeds half the spacing (${metres(spacingMm / 2)})`);
    }
  }
  if (stations.length === 0 && carriers[0] === null && carriers[1] === null) warnings.push(`${mark} has no support`);
  const counts = new Map<string, number>();
  for (const warning of warnings) counts.set(warning, (counts.get(warning) ?? 0) + 1);
  return [...counts].map(([warning, times]) => (times > 1 ? `${warning} (x${times})` : warning));
}
