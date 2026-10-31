/**
 * Centreline geometry of the process line objects (plant 08 DAT §5.4): the polylines of the pipes bound to a line (legacy pipe runs of the
 * building slice, routed runs of `doc.plant.piping`), their length in metres, straights, bends and end points. A line object owns the
 * polylines of its own target and of every object whose `lineId` names it. Pure.
 */

import { getBuilding } from '@aec/building/model';
import { atLevel } from '@aec/industrial/evaluate';
import { routeLength } from '@aec/industrial/piping/routeSupport';
import type { CadDocument, Vec3 } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { isProcessLine } from '../lines';
import { getPlantData, type PlantObject } from '../model';
import { getPiping } from '../../piping/model';
import { round6 } from './types';

export interface LineGeometry {
  /** Centreline length in metres, null when no pipe of the line exists in the model. */
  readonly lengthM: number | null;
  readonly straights: number | null;
  readonly bends: number | null;
  /** First and last point of the route in world coordinates (document units). */
  readonly start: Vec3 | null;
  readonly end: Vec3 | null;
  /** Nominal size DN of the first pipe that carries one. */
  readonly dn: number | null;
}

const NONE: LineGeometry = { lengthM: null, straights: null, bends: null, start: null, end: null, dn: null };

function polylinesOf(doc: CadDocument, object: PlantObject): { points: readonly Vec3[]; dn?: number }[] {
  const target = object.target;
  if (target.kind === 'buildingElement') {
    const building = getBuilding(doc);
    const pipe = building.elements[target.id];
    const level = pipe?.category === 'pipe' ? building.levels[pipe.levelId] : undefined;
    if (pipe?.category !== 'pipe' || level === undefined) return [];
    return [{ points: pipe.points.map((point) => atLevel(level, point)), ...(pipe.dn === undefined ? {} : { dn: pipe.dn }) }];
  }
  if (target.kind === 'provider' && target.provider === 'pipeLine') {
    const piping = getPiping(doc);
    const line = piping.lines[target.id];
    return piping.runOrder.flatMap((runId) => {
      const run = piping.runs[runId];
      if (run === undefined || run.lineId !== target.id) return [];
      const dn = run.dn ?? line?.dn;
      return [{ points: [run.start.point, ...run.pis, run.end.point], ...(dn === undefined ? {} : { dn }) }];
    });
  }
  return [];
}

/** Geometry of every process line object, by object id. */
export function lineGeometries(doc: CadDocument): ReadonlyMap<string, LineGeometry> {
  const data = getPlantData(doc);
  const members = new Map<string, PlantObject[]>();
  for (const id of data.objectOrder) {
    const object = data.objects[id];
    if (object?.lineId !== undefined) members.set(object.lineId, [...(members.get(object.lineId) ?? []), object]);
  }
  const result = new Map<string, LineGeometry>();
  for (const id of data.objectOrder) {
    const line = data.objects[id];
    if (line === undefined || !isProcessLine(data, line)) continue;
    const lines = [line, ...(members.get(line.id) ?? [])]
      .flatMap((object) => polylinesOf(doc, object))
      .filter((poly) => poly.points.length >= 2);
    if (lines.length === 0) {
      result.set(line.id, NONE);
      continue;
    }
    const length = lines.reduce((sum, poly) => sum + routeLength(poly.points), 0);
    const dn = lines.find((poly) => poly.dn !== undefined)?.dn;
    result.set(line.id, {
      lengthM: round6(toMetres(doc, length)),
      straights: lines.reduce((sum, poly) => sum + poly.points.length - 1, 0),
      bends: lines.reduce((sum, poly) => sum + poly.points.length - 2, 0),
      start: (lines[0]?.points[0] as Vec3 | undefined) ?? null,
      end: (lines.at(-1)?.points.at(-1) as Vec3 | undefined) ?? null,
      dn: dn ?? null,
    });
  }
  return result;
}
