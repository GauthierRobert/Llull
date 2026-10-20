/** Tool faces of doubly curved tools (06 CMP M3): the hemispherical cap of a `sphere` and the sheet of a `nurbs_surface`. */

import type { PartSurface, Rosette } from '@core/model/composites';
import type { Entity, Vec3 } from '@core/model/types';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { placedSurface } from '@core/geometry/nurbsSurface';
import { closestOnSurface, surfaceProbe } from '@lib/nurbs/closest';
import { len3, normalize3, sub3 } from '@lib/vec3';
import { nurbsOutline, nurbsPartSurface, sphereOutline, sphereXDir } from './curved';
import type { FaceResolution } from './faceResolution';

/**
 * The part surface + chart outline of a sphere / nurbs_surface tool near `near`, or null for other kinds.
 * @invariant sphere: the hemisphere centred on the direction of `near` with azimuth 0 along the rosette 0-degree axis; nurbs: the whole sheet
 * @failure `near` farther than `tolerance` from the surface -> CMP_FACE_NOT_FOUND; rosette axis parallel to the pole direction -> CMP_ROSETTE_DEGENERATE
 */
export function curvedFace(entity: Entity, near: Vec3, rosette: Rosette, tolerance: number, arcTolerance: number): FaceResolution | null {
  if (entity.kind === 'sphere') {
    const center = entityLocalToWorld(entity, [0, 0, 0]);
    const offset = sub3(near, center);
    if (Math.abs(len3(offset) - entity.radius) > tolerance)
      return {
        ok: false,
        code: 'CMP_FACE_NOT_FOUND',
        message: `no face of '${entity.id}' lies within ${tolerance} of [${near.join(', ')}]`,
      };
    const axis = normalize3(offset);
    const xDir = sphereXDir(axis, rosette.axis0);
    if (xDir === null)
      return {
        ok: false,
        code: 'CMP_ROSETTE_DEGENERATE',
        message: 'the rosette 0-degree axis is parallel to the pole direction of the sphere cap',
      };
    const surface: PartSurface = { type: 'sphere', center, axis, xDir, radius: entity.radius };
    return { ok: true, surface, outline: sphereOutline(surface, arcTolerance) };
  }
  if (entity.kind === 'nurbs_surface') {
    const world = placedSurface(entity);
    const hit = closestOnSurface(world, near, surfaceProbe(world));
    if (hit.distance > tolerance)
      return {
        ok: false,
        code: 'CMP_FACE_NOT_FOUND',
        message: `no face of '${entity.id}' lies within ${tolerance} of [${near.join(', ')}]`,
      };
    const surface = nurbsPartSurface(world);
    return { ok: true, surface, outline: nurbsOutline(surface) };
  }
  return null;
}
