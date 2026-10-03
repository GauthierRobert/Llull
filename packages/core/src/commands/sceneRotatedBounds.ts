import type { Entity, Vec3 } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { type Bounds } from './sceneTypes';
import { entityBounds, pointsExtent, positionsExtent } from './sceneBounds';

/**
 * Return the local-space corners of an entity's oriented bounding box — i.e.
 * the vertices of the OBB **before** applying `entity.rotation` or `entity.position`.
 * Each point is in the entity's own coordinate frame centred at its position.
 *
 * For 2D entities (flat in the Z=0 plane) rotation is rarely non-zero, but the
 * helper is exhaustive so `rotatedEntityBounds` can handle every kind uniformly.
 *
 * @pure
 */
function localEntityCorners(e: Entity): Vec3[] {
  switch (e.kind) {
    case 'box': {
      const [w, h, d] = e.size;
      const hw = w / 2,
        hh = h / 2,
        hd = d / 2;
      return [
        [-hw, -hh, -hd],
        [hw, -hh, -hd],
        [hw, hh, -hd],
        [-hw, hh, -hd],
        [-hw, -hh, hd],
        [hw, -hh, hd],
        [hw, hh, hd],
        [-hw, hh, hd],
      ];
    }
    case 'cylinder': {
      // Z-up AABB of cylinder: radius in X/Y, height along Z, centered at position.
      const r = e.radius,
        hh = e.height / 2;
      return [
        [-r, -r, -hh],
        [r, -r, -hh],
        [r, r, -hh],
        [-r, r, -hh],
        [-r, -r, hh],
        [r, -r, hh],
        [r, r, hh],
        [-r, r, hh],
      ];
    }
    case 'sphere': {
      const r = e.radius;
      return [
        [-r, -r, -r],
        [r, -r, -r],
        [r, r, -r],
        [-r, r, -r],
        [-r, -r, r],
        [r, -r, r],
        [r, r, r],
        [-r, r, r],
      ];
    }
    case 'extrusion': {
      const { minX, minY, maxX, maxY } = pointsExtent(e.profile);
      return [
        [minX, minY, 0],
        [maxX, minY, 0],
        [maxX, maxY, 0],
        [minX, maxY, 0],
        [minX, minY, e.depth],
        [maxX, minY, e.depth],
        [maxX, maxY, e.depth],
        [minX, maxY, e.depth],
      ];
    }
    case 'mesh': {
      const p = e.mesh.positions;
      // @invariant positions is a flat Float32-style array of xyz triples; one triangle = 9 floats minimum.
      if (p.length < 9 || p.length % 3 !== 0) return [[0, 0, 0]];
      const { min, max } = positionsExtent(p);
      const [minX, minY, minZ] = min;
      const [maxX, maxY, maxZ] = max;
      // @invariant positions are world-space; subtract position so rotatedEntityBounds
      // round-trips correctly (it adds position back for every corner).
      const px = e.position[0],
        py = e.position[1],
        pz = e.position[2];
      return [
        [minX - px, minY - py, minZ - pz],
        [maxX - px, minY - py, minZ - pz],
        [maxX - px, maxY - py, minZ - pz],
        [minX - px, maxY - py, minZ - pz],
        [minX - px, minY - py, maxZ - pz],
        [maxX - px, minY - py, maxZ - pz],
        [maxX - px, maxY - py, maxZ - pz],
        [minX - px, maxY - py, maxZ - pz],
      ];
    }
    case 'cone': {
      // Base circle in XY at z=0; apex at z=height. OBB: radius in X/Y, height in Z.
      const r = e.radius,
        h = e.height;
      return [
        [-r, -r, 0],
        [r, -r, 0],
        [r, r, 0],
        [-r, r, 0],
        [0, 0, h],
      ];
    }
    case 'torus': {
      const outer = e.ringRadius + e.tubeRadius,
        t = e.tubeRadius;
      return [
        [-outer, -outer, -t],
        [outer, -outer, -t],
        [outer, outer, -t],
        [-outer, outer, -t],
        [-outer, -outer, t],
        [outer, -outer, t],
        [outer, outer, t],
        [-outer, outer, t],
      ];
    }
    case 'wedge': {
      const [ww, wh, wd] = e.size;
      // Lower-front-left corner is at local (0,0,0); extends +X/+Y/+Z.
      return [
        [0, 0, 0],
        [ww, 0, 0],
        [ww, wh, 0],
        [0, wh, 0],
        [0, 0, wd],
        [ww, 0, wd],
        [ww, wh, wd],
        [0, wh, wd],
      ];
    }
    case 'pyramid': {
      const hw = e.baseWidth / 2,
        hd = e.baseDepth / 2;
      return [
        [-hw, -hd, 0],
        [hw, -hd, 0],
        [hw, hd, 0],
        [-hw, hd, 0],
        [0, 0, e.height],
      ];
    }
    case 'revolution': {
      // Conservative OBB corners: cylinder wrapping the swept profile.
      const maxR = e.profile.reduce((m, [x]) => Math.max(m, Math.abs(x)), 0);
      const axialValues = e.profile.map(([, y]) => y);
      const minA = Math.min(...axialValues);
      const maxA = Math.max(...axialValues);
      const [ax, ay, az] = e.axis;
      const abx = Math.abs(ax),
        aby = Math.abs(ay),
        abz = Math.abs(az);
      if (abz >= abx && abz >= aby) {
        // Z-axis: radial in XY, axial in Z
        return [
          [-maxR, -maxR, minA],
          [maxR, -maxR, minA],
          [maxR, maxR, minA],
          [-maxR, maxR, minA],
          [-maxR, -maxR, maxA],
          [maxR, -maxR, maxA],
          [maxR, maxR, maxA],
          [-maxR, maxR, maxA],
        ];
      } else if (aby >= abx) {
        // Y-axis: radial in XZ, axial in Y
        return [
          [-maxR, minA, -maxR],
          [maxR, minA, -maxR],
          [maxR, minA, maxR],
          [-maxR, minA, maxR],
          [-maxR, maxA, -maxR],
          [maxR, maxA, -maxR],
          [maxR, maxA, maxR],
          [-maxR, maxA, maxR],
        ];
      } else {
        // X-axis: radial in YZ, axial in X
        return [
          [minA, -maxR, -maxR],
          [maxA, -maxR, -maxR],
          [maxA, maxR, -maxR],
          [minA, maxR, -maxR],
          [minA, -maxR, maxR],
          [maxA, -maxR, maxR],
          [maxA, maxR, maxR],
          [minA, maxR, maxR],
        ];
      }
    }
    // 2D kinds — all flat in the Z=0 plane; OBB corners are their 2D AABB corners.
    case 'line': {
      const minX = Math.min(e.start[0], e.end[0]);
      const maxX = Math.max(e.start[0], e.end[0]);
      const minY = Math.min(e.start[1], e.end[1]);
      const maxY = Math.max(e.start[1], e.end[1]);
      return [
        [minX, minY, 0],
        [maxX, minY, 0],
        [maxX, maxY, 0],
        [minX, maxY, 0],
      ];
    }
    case 'polyline':
    case 'spline': {
      if (e.points.length === 0) return [[0, 0, 0]];
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const [x, y] of e.points) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return [
        [minX, minY, 0],
        [maxX, minY, 0],
        [maxX, maxY, 0],
        [minX, maxY, 0],
      ];
    }
    case 'arc':
    case 'circle': {
      const r = e.radius;
      const cx = e.center[0],
        cy = e.center[1];
      return [
        [cx - r, cy - r, 0],
        [cx + r, cy - r, 0],
        [cx + r, cy + r, 0],
        [cx - r, cy + r, 0],
      ];
    }
    case 'ellipse': {
      const cx = e.center[0],
        cy = e.center[1];
      return [
        [cx - e.radiusX, cy - e.radiusY, 0],
        [cx + e.radiusX, cy - e.radiusY, 0],
        [cx + e.radiusX, cy + e.radiusY, 0],
        [cx - e.radiusX, cy + e.radiusY, 0],
      ];
    }
    case 'rectangle':
      return [
        [0, 0, 0],
        [e.width, 0, 0],
        [e.width, e.height, 0],
        [0, e.height, 0],
      ];
    case 'point':
      return [[0, 0, 0]];
    case 'text': {
      const estimatedWidth = e.content.length * e.height * 0.6;
      return [
        [0, 0, 0],
        [estimatedWidth, 0, 0],
        [estimatedWidth, e.height, 0],
        [0, e.height, 0],
      ];
    }
    case 'dimension': {
      const ext = e.offset ?? 5;
      return [
        [-ext, -ext, 0],
        [ext, -ext, 0],
        [ext, ext, 0],
        [-ext, ext, 0],
      ];
    }
    case 'instance': {
      // Instance has no own geometry in local space — collapse to a single point.
      // rotatedEntityBounds will offset this by e.position producing a point AABB.
      // Callers needing accurate bounds should use instanceBoundsFromDoc instead.
      return [[0, 0, 0]];
    }
    default: {
      // Compile-time exhaustiveness check: adding a new EntityKind without a case here is a type error.
      const _exhaustive: never = e;
      void _exhaustive;
      return [[0, 0, 0]];
    }
  }
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

  const corners = localEntityCorners(e);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const local of corners) {
    // local corner is relative to position=0; rotate it about the entity origin
    const world = applyEulerXYZ(
      [e.position[0] + local[0], e.position[1] + local[1], e.position[2] + local[2]],
      e.position,
      e.rotation,
    );
    if (world[0] < minX) minX = world[0];
    if (world[0] > maxX) maxX = world[0];
    if (world[1] < minY) minY = world[1];
    if (world[1] > maxY) maxY = world[1];
    if (world[2] < minZ) minZ = world[2];
    if (world[2] > maxZ) maxZ = world[2];
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    oriented: true,
  };
}
