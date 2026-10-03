import type { Entity, Vec3 } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { type Bounds } from './sceneTypes';
import { boundsCorners, boundsOfPoints, entityBounds, localBounds } from './sceneBounds';

/**
 * Local-space (pre-rotation, pre-position) points whose rotated hull bounds an entity.
 * Cones/pyramids use base corners + apex (tighter than the full AABB); a mesh without a full
 * triangle collapses to the origin.
 *
 * @pure
 */
function localEntityCorners(e: Entity): Vec3[] {
  if (e.kind === 'mesh') {
    const p = e.mesh.positions;
    // @invariant positions is a flat array of xyz triples; one triangle = 9 floats minimum.
    if (p.length < 9 || p.length % 3 !== 0) return [[0, 0, 0]];
  }
  const local = localBounds(e);
  const corners = boundsCorners(local);
  return e.kind === 'cone' || e.kind === 'pyramid'
    ? [...corners.slice(0, 4), [0, 0, local.max[2]]]
    : corners;
}

/**
 * World-space AABB of one entity, with rotation correctly applied when non-zero.
 *
 * When `entity.rotation` is `[0,0,0]` the result is byte-for-byte identical to
 * the previous `entityBounds` output (back-compat). When rotation is non-zero
 * the returned bounds wrap the actual oriented geometry and carry `oriented:true`
 * so an agent knows the AABB reflects the real rotated extents.
 *
 * Approach: enumerate the OBB corners in local space, apply `applyEulerXYZ`
 * (three.js Rx·Ry·Rz, matching the live viewport), offset by `position`, then
 * compute the world-space AABB of those transformed corners.
 *
 * @pure
 * @affects nothing — read-only helper
 */
export function rotatedEntityBounds(e: Entity): Bounds {
  if (isZeroRotation(e.rotation)) {
    // Fast path: zero rotation → return the same AABB as before (no oriented flag).
    return entityBounds(e);
  }

  // Rotate each local corner about the entity origin, then take the world-space AABB.
  const rotated = localEntityCorners(e).map((local) =>
    applyEulerXYZ(
      [e.position[0] + local[0], e.position[1] + local[1], e.position[2] + local[2]],
      e.position,
      e.rotation,
    ),
  );
  return { ...boundsOfPoints(rotated), oriented: true };
}
