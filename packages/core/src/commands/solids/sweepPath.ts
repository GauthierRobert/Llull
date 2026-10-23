/** Path of a sweep: world points (bends or a smooth spline), 2D sketch curves, 3D nurbs_curves, chains of them, helix definitions. */

import type { CurveSegment } from '../../model/curve';
import type { CadDocument, Vec3 } from '../../model/types';
import { isVec3, add3, sub3 } from '../../lib/vec3';
import { mapSurfacePoles } from '../../lib/nurbs/surface';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { HelixDefinition } from '../../lib/helix/types';
import { MAX_PROFILE_POINTS } from '../limits';
import { nurbsPath } from '../../geometry/nurbsChain';
import { placedSurface } from '../../geometry/nurbsSurface';
import { catmullRomBeziers, filletClosedPolygon, filletPolyline, JOINT_TOLERANCE, reverseChain } from '../../geometry/curveSegments';
import { distance3 } from '../../lib/vec3';
import { sketchPath } from './sketchCurves';

/** World chain of one curve entity (3D nurbs_curve, or a 2D sketch curve; a polyline / rectangle keeps its corners for bending), or the reason it is unusable. */
function entityPath(
  doc: CadDocument,
  id: string,
  smooth: boolean,
  bendRadius: number,
  miter: boolean,
): { chain: CurveSegment<Vec3>[]; closed: boolean } | string {
  const entity = doc.entities[id];
  if (entity?.kind === 'nurbs_curve') {
    const chain = nurbsPath(entity);
    return typeof chain === 'string' ? chain : { chain, closed: false };
  }
  const world = sketchPath(doc, id);
  if (typeof world === 'string' || (entity?.kind !== 'polyline' && entity?.kind !== 'rectangle'))
    return typeof world === 'string' ? world : { chain: world, closed: false };
  const loop = entity.kind === 'rectangle' || entity.closed;
  const corners = world.map((segment) => segment.points[0] as Vec3);
  if (!loop) corners.push(world[world.length - 1]?.points[1] as Vec3);
  const chain = bentOrSmooth(corners, loop, smooth, bendRadius, miter);
  return typeof chain === 'string' ? chain : { chain, closed: loop };
}

/** Curves joined end to end (each reversed when its far end is the one that meets the chain), or the reason they do not connect. */
function chainOf(
  doc: CadDocument,
  ids: readonly string[],
  smooth: boolean,
  bendRadius: number,
  miter: boolean,
): CurveSegment<Vec3>[] | string {
  let joined: CurveSegment<Vec3>[] = [];
  for (const [index, id] of ids.entries()) {
    const made = entityPath(doc, id, smooth, bendRadius, miter);
    if (typeof made === 'string') return made;
    if (made.closed) return `pathIds[${index}] "${id}" is a closed loop and cannot be one link of a chain`;
    let next = made.chain;
    if (joined.length > 0) {
      const tail = joined[joined.length - 1]?.points[(joined[joined.length - 1]?.points.length as number) - 1] as Vec3;
      const near = (chain: CurveSegment<Vec3>[]): number => distance3(tail, chain[0]?.points[0] as Vec3);
      const flipped = reverseChain(next);
      if (near(flipped) < near(next)) next = flipped;
      if (near(next) > JOINT_TOLERANCE)
        return `the chain is disconnected between pathIds[${index - 1}] and pathIds[${index}] "${id}" (gap ${near(next).toExponential(2)})`;
    }
    joined = [...joined, ...next];
  }
  return joined;
}

/** World path from points (bends or smooth spline), one curve entity, or a chain of curve entities (`pathIds`), or an error message. */
export function resolvePath(
  doc: CadDocument,
  path: ReadonlyArray<unknown> | undefined,
  pathId: string | undefined,
  smooth: boolean,
  bendRadius: number,
  closed: boolean,
  pathIds?: readonly string[] | undefined,
  miter = false,
): CurveSegment<Vec3>[] | string {
  if ([path, pathId, pathIds].filter((value) => value !== undefined).length !== 1)
    return 'give exactly one of path or pathId (or a pathIds chain)';
  if (pathIds !== undefined) return pathIds.length < 2 ? 'pathIds needs >= 2 curve ids' : chainOf(doc, pathIds, smooth, bendRadius, miter);
  if (path !== undefined) {
    const bad = path.findIndex((point) => !isVec3(point));
    if (bad >= 0) return `path point ${bad} must be a finite [x, y, z] triple`;
    const points = path as Vec3[];
    if (points.length < 2 || points.length > MAX_PROFILE_POINTS) return `path needs 2..${MAX_PROFILE_POINTS} points (got ${points.length})`;
    return bentOrSmooth(points, closed, smooth, bendRadius, miter);
  }
  const made = entityPath(doc, pathId as string, smooth, bendRadius, miter);
  return typeof made === 'string' ? made : made.chain;
}

/** The sheet `id` as a surface local to the sweep (path start at the origin), or the reason it is unusable. */
export function localSurface(doc: CadDocument, id: string, start: Vec3): NurbsSurfaceData | string {
  const entity = doc.entities[id];
  if (entity?.kind !== 'nurbs_surface') return `orientation.surfaceId "${id}" is not a nurbs_surface`;
  return mapSurfacePoles(placedSurface(entity), (pole) => sub3(pole, start));
}

/** The exact helix of a `nurbs_curve` path (`add_helix`), moved to the sweep's local frame; undefined for any other path or a rotated curve. */
export function pathHelix(doc: CadDocument, pathId: string | undefined, start: Vec3): HelixDefinition | undefined {
  const curve = pathId === undefined ? undefined : doc.entities[pathId];
  if (curve?.kind !== 'nurbs_curve' || curve.analytic === undefined || curve.rotation.some((angle) => angle !== 0)) return undefined;
  return { ...curve.analytic, origin: sub3(add3(curve.position, curve.analytic.origin), start) };
}

/** Corner points joined by bends (or a smooth spline through them), open or closed. */
function bentOrSmooth(
  points: readonly Vec3[],
  closed: boolean,
  smooth: boolean,
  bendRadius: number,
  miter: boolean,
): CurveSegment<Vec3>[] | string {
  if (miter) {
    if (closed || smooth) return 'mitre corners need an open path of straight runs (not closed, not smooth)';
    return points.slice(1).map((point, i): CurveSegment<Vec3> => ({ type: 'line', points: [points[i] as Vec3, point] }));
  }
  if (smooth) return catmullRomBeziers(points, closed);
  return closed ? filletClosedPolygon(points, bendRadius) : filletPolyline(points, bendRadius);
}
