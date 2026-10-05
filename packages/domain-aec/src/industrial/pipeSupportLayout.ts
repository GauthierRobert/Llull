/**
 * Pipes as absolute mm routes with their supports: arc-length stations along the centreline and
 * the ends carried by equipment nozzles or other pipes. Shared by the support loads and the span check.
 * @layer domain-aec
 * @pure
 */

import type { PipeElement, PipeSupportElement } from '@core/model/building';
import type { Vec3 } from '@core/model/types';
import { elementsOf } from '../model';
import type { ModelUnits } from './steelMemberBars';
import { RISER_SLOPE, arcLengths, nearestOnRoute, spanCoordinate } from './routeSupport';
import { pipeSpanLimit } from './pipeSpans';

export interface PipeRun {
  readonly element: PipeElement;
  /** Absolute centreline, mm. */
  readonly points: Vec3[];
  readonly diameterMm: number;
  readonly lengthMm: number;
}

/** What carries a pipe end: equipment (nozzle) or another pipe (branch on a header). */
export type EndCarrier = 'equipment' | 'pipe';

export interface SupportStation {
  readonly id: string;
  readonly mark: string;
  readonly type: PipeSupportElement['type'];
  /** Arc length from the pipe start, mm. */
  readonly arc: number;
  /** Absolute centreline point of the support, mm. */
  readonly point: Vec3;
  readonly memberId: string | null;
  /** Bears on an existing steel member. */
  readonly attached: boolean;
  /** Sits on a riser (steep segment): a clamp with a bracket, not a support under a horizontal run. */
  readonly onRiser: boolean;
}

/** Supports closer than this along a pipe are one support, mm. */
export const SAME_SUPPORT_DISTANCE = 100;

/** Absolute mm position of a point given in document units relative to level `levelId`. */
export function absolutePointMm(units: ModelUnits, levelId: string, point: Vec3): Vec3 {
  return [
    units.toMm(point[0]),
    units.toMm(point[1]),
    units.elevationMm(levelId) + units.toMm(point[2]),
  ];
}

/** Absolute mm route of a pipe element. */
export function pipeRunOf(units: ModelUnits, element: PipeElement): PipeRun {
  const points = element.points.map((point) => absolutePointMm(units, element.levelId, point));
  return {
    element,
    points,
    diameterMm: units.toMm(element.diameter),
    lengthMm: arcLengths(points).at(-1) ?? 0,
  };
}

/** Every pipe of the building, in model order. */
export function pipeRunsOf(units: ModelUnits): PipeRun[] {
  return elementsOf(units.building, 'pipe').map((pipe) => pipeRunOf(units, pipe));
}

/** Supports of pipe `pipeId`, in model order. */
export function supportsOfPipe(units: ModelUnits, pipeId: string): PipeSupportElement[] {
  return elementsOf(units.building, 'pipeSupport').filter((support) => support.pipeId === pipeId);
}

/** Support stations of a pipe sorted by arc length; unattached supports are listed with `attached` false. */
export function supportStations(
  units: ModelUnits,
  run: PipeRun,
  supports: ReadonlyArray<PipeSupportElement>,
): SupportStation[] {
  return supports
    .flatMap((support): SupportStation[] => {
      const snap = nearestOnRoute(
        run.points,
        absolutePointMm(units, run.element.levelId, support.position),
      );
      if (snap === null) return [];
      const member =
        support.memberId === null ? undefined : units.building.elements[support.memberId];
      return [
        {
          id: support.id,
          mark: support.mark,
          type: support.type,
          arc: snap.arc,
          point: snap.point,
          memberId: support.memberId,
          attached: member?.category === 'member',
          onRiser: Math.abs(snap.direction[2]) > RISER_SLOPE,
        },
      ];
    })
    .sort((a, b) => a.arc - b.arc);
}

/** A guide on a riser restrains it laterally only: it carries none of the pipe weight. */
export const isLateralOnly = (station: Pick<SupportStation, 'onRiser' | 'type'>): boolean =>
  station.onRiser && station.type === 'guide';

/** Supports of `run` that carry pipe weight: all but the guides on risers. */
export function weightSupportsOf(units: ModelUnits, run: PipeRun): PipeSupportElement[] {
  const supports = supportsOfPipe(units, run.element.id);
  const lateral = new Set(
    supportStations(units, run, supports)
      .filter(isLateralOnly)
      .map((station) => station.id),
  );
  return supports.filter((support) => !lateral.has(support.id));
}

/** True when `point` (absolute mm) lies inside the equipment footprint box (1 mm margin). */
function insideEquipment(units: ModelUnits, point: Vec3): boolean {
  const { building, toMm, elevationMm } = units;
  return Object.values(building.elements).some((element) => {
    if (element.category !== 'equipment') return false;
    const [length, width, height] = element.size.map(toMm) as [number, number, number];
    const [dx, dy] = [point[0] - toMm(element.location[0]), point[1] - toMm(element.location[1])];
    const [cos, sin] = [Math.cos(element.angle), Math.sin(element.angle)];
    const [along, across] = [dx * cos + dy * sin, -dx * sin + dy * cos];
    const base = elevationMm(element.levelId);
    return (
      Math.abs(along) <= length / 2 + 1 &&
      Math.abs(across) <= width / 2 + 1 &&
      point[2] >= base - 1 &&
      point[2] <= base + height + 1
    );
  });
}

/**
 * What carries each end of `run`: equipment whose footprint contains the end point (a nozzle), else
 * a different pipe whose centreline passes within the larger outside diameter (a branch on a header).
 */
export function endCarriers(
  units: ModelUnits,
  run: PipeRun,
  runs: ReadonlyArray<PipeRun>,
): [EndCarrier | null, EndCarrier | null] {
  const carrier = (point: Vec3 | undefined): EndCarrier | null => {
    if (point === undefined) return null;
    if (insideEquipment(units, point)) return 'equipment';
    const onPipe = runs.some((other) => {
      if (other.element.id === run.element.id) return false;
      const snap = nearestOnRoute(other.points, point);
      return snap !== null && snap.distance <= Math.max(run.diameterMm, other.diameterMm);
    });
    return onPipe ? 'pipe' : null;
  };
  return [carrier(run.points[0]), carrier(run.points.at(-1))];
}

/**
 * True when both ends of `run` are carried (equipment nozzle / header) and its span length — risers
 * not counted — is within the table span of its size: it needs no support of its own.
 */
export function carriedByEnds(units: ModelUnits, run: PipeRun): boolean {
  const [start, end] = endCarriers(units, run, pipeRunsOf(units));
  const limit = pipeSpanLimit(run.element.dn, run.diameterMm);
  return (
    start !== null &&
    end !== null &&
    spanCoordinate(run.points, run.lengthMm) / 1000 <= limit.spanM + 1e-9
  );
}
