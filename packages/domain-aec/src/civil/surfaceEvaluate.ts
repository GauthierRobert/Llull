/**
 * Evaluates survey point groups (point markers) and surfaces (TIN mesh, minor / major contours and
 * major-contour elevation labels).
 * @layer domain-aec/civil
 * @pure
 */

import type { Entity, Vec2 } from '@core/model/types';
import type { PointGroupObject, SurfaceObject } from '@core/model/civil';
import { civilMesh, civilPoint, civilPolyline, civilText } from './entities';
import { contourLevels, tinMesh, traceContour } from './tin';
import { surfaceTin } from './surfaceTin';
import { labelHeight, type CivilContext } from './context';
import { toMetres } from '../model';

/** Above this many points a group is kept as data only (no per-point markers). */
export const MAX_DRAWN_POINTS = 2000;
/** Contour polylines drawn per surface at most (the coarsest levels are kept). */
export const MAX_CONTOUR_LINES = 3000;

export function evaluatePointGroup(_context: CivilContext, group: PointGroupObject): Entity[] {
  if (group.points.length > MAX_DRAWN_POINTS) return [];
  return group.points.map((point, index) =>
    civilPoint(group, `p${index}`, `${group.name} ${point.number}`, 'points', point.position),
  );
}

function elevationLabel(doc: CivilContext['doc'], elevation: number): string {
  return toMetres(doc, elevation).toFixed(2);
}

function midpoint(line: ReadonlyArray<Vec2>): { at: Vec2; angle: number } {
  const index = Math.max(0, Math.floor((line.length - 1) / 2));
  const a = line[index] as Vec2;
  const b = (line[index + 1] ?? a) as Vec2;
  let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return { at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], angle };
}

export function evaluateSurface(context: CivilContext, surface: SurfaceObject): Entity[] {
  const tin = surfaceTin(context.civil, surface);
  if (tin.triangles.length === 0) return [];
  const entities: Entity[] = [civilMesh(surface, 'tin', `${surface.name} TIN`, 'tin', tinMesh(tin))];
  const height = labelHeight(context.doc);
  let lines = 0;
  contourLevels(tin, surface.contourInterval).forEach((level) => {
    const index = Math.round(level / surface.contourInterval);
    const major = surface.majorEvery > 0 && index % surface.majorEvery === 0;
    traceContour(tin, level).forEach((line, k) => {
      if (line.length < 2 || lines >= MAX_CONTOUR_LINES) return;
      lines += 1;
      const first = line[0] as Vec2;
      const last = line[line.length - 1] as Vec2;
      const closed = line.length > 3 && first[0] === last[0] && first[1] === last[1];
      const points = closed ? line.slice(0, -1) : line;
      const part = `c${index}_${k}`;
      const label = `${surface.name} contour ${elevationLabel(context.doc, level)}`;
      entities.push(
        civilPolyline(surface, part, label, major ? 'major' : 'minor', points, closed, level),
      );
      if (major && line.length >= 4) {
        const { at, angle } = midpoint(line);
        entities.push(
          civilText(
            surface,
            `${part}_label`,
            elevationLabel(context.doc, level),
            'major',
            [at[0], at[1], level],
            height,
            angle,
          ),
        );
      }
    });
  });
  return entities;
}
