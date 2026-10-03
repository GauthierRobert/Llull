import type { CadDocument, Entity, InstanceEntity, Vec3 } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { type Bounds } from './sceneTypes';

function offset(p: Vec3, dx: number, dy: number, dz: number): Vec3 {
  return [p[0] + dx, p[1] + dy, p[2] + dz];
}

/** Min/max of a flat xyz position array (`[x0, y0, z0, x1, ...]`); needs at least one full triple. */
export function positionsExtent(positions: readonly number[]): { min: Vec3; max: Vec3 } {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] as number,
      y = positions[i + 1] as number,
      z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** 2D extents of `points`; all zeros for an empty list. */
export function pointsExtent(points: ReadonlyArray<readonly [number, number]>): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** World-space AABB of one entity, matching how the viewport places each kind. */
export function entityBounds(e: Entity): Bounds {
  switch (e.kind) {
    case 'box': {
      const [w, h, d] = e.size;
      return {
        min: offset(e.position, -w / 2, -h / 2, -d / 2),
        max: offset(e.position, w / 2, h / 2, d / 2),
      };
    }
    case 'cylinder':
      // Z-up: axis along Z, centered at position (matches render.ts / export.ts).
      return {
        min: offset(e.position, -e.radius, -e.radius, -e.height / 2),
        max: offset(e.position, e.radius, e.radius, e.height / 2),
      };
    case 'sphere':
      return {
        min: offset(e.position, -e.radius, -e.radius, -e.radius),
        max: offset(e.position, e.radius, e.radius, e.radius),
      };
    case 'extrusion': {
      const { minX, minY, maxX, maxY } = pointsExtent(e.profile);
      // ExtrudeGeometry extrudes along +Z from the profile plane.
      return {
        min: offset(e.position, minX, minY, 0),
        max: offset(e.position, maxX, maxY, e.depth),
      };
    }
    case 'mesh': {
      const p = e.mesh.positions;
      if (p.length < 3) return { min: e.position, max: e.position };
      return positionsExtent(p);
    }
    case 'cone':
      // Base circle centered at position in XY; apex at position+height in Z.
      return {
        min: offset(e.position, -e.radius, -e.radius, 0),
        max: offset(e.position, e.radius, e.radius, e.height),
      };
    case 'torus':
      // Torus ring in XY plane: outer extent is ringRadius+tubeRadius; tube extends ±tubeRadius in Z.
      return {
        min: offset(
          e.position,
          -(e.ringRadius + e.tubeRadius),
          -(e.ringRadius + e.tubeRadius),
          -e.tubeRadius,
        ),
        max: offset(
          e.position,
          e.ringRadius + e.tubeRadius,
          e.ringRadius + e.tubeRadius,
          e.tubeRadius,
        ),
      };
    case 'wedge': {
      // Wedge lower-front-left corner is at position; bounding box is the full size.
      const [ww, wh, wd] = e.size;
      return { min: e.position, max: offset(e.position, ww, wh, wd) };
    }
    case 'pyramid': {
      // Base centered at position; apex at position+height in Z.
      const hw = e.baseWidth / 2;
      const hd = e.baseDepth / 2;
      return {
        min: offset(e.position, -hw, -hd, 0),
        max: offset(e.position, hw, hd, e.height),
      };
    }
    case 'revolution': {
      // Conservative AABB: max radial offset sweeps a cylinder around the axis.
      // We compute the bounding box of the swept profile for the primary axes only.
      // For non-axis-aligned axes the bounds are conservative (a cube wrapping the cylinder).
      const maxR = e.profile.reduce((m, [x]) => Math.max(m, Math.abs(x)), 0);
      const axialValues = e.profile.map(([, y]) => y);
      const minAxial = Math.min(...axialValues);
      const maxAxial = Math.max(...axialValues);
      const [ax, ay, az] = e.axis;
      // Determine which world axis the revolution axis aligns with (largest component).
      const abx = Math.abs(ax),
        aby = Math.abs(ay),
        abz = Math.abs(az);
      if (abz >= abx && abz >= aby) {
        // Z-axis revolution: radial in XY, axial in Z
        return {
          min: offset(e.position, -maxR, -maxR, minAxial),
          max: offset(e.position, maxR, maxR, maxAxial),
        };
      } else if (aby >= abx) {
        // Y-axis revolution: radial in XZ, axial in Y
        return {
          min: offset(e.position, -maxR, minAxial, -maxR),
          max: offset(e.position, maxR, maxAxial, maxR),
        };
      } else {
        // X-axis revolution: radial in YZ, axial in X
        return {
          min: offset(e.position, minAxial, -maxR, -maxR),
          max: offset(e.position, maxAxial, maxR, maxR),
        };
      }
    }
    case 'line': {
      const minX = Math.min(e.start[0], e.end[0]);
      const maxX = Math.max(e.start[0], e.end[0]);
      const minY = Math.min(e.start[1], e.end[1]);
      const maxY = Math.max(e.start[1], e.end[1]);
      return { min: offset(e.position, minX, minY, 0), max: offset(e.position, maxX, maxY, 0) };
    }
    case 'polyline': {
      if (e.points.length === 0) return { min: e.position, max: e.position };
      const { minX, minY, maxX, maxY } = pointsExtent(e.points);
      return { min: offset(e.position, minX, minY, 0), max: offset(e.position, maxX, maxY, 0) };
    }
    case 'arc':
    case 'circle':
      // Conservative: full center±radius box (arcs are not angle-trimmed here).
      return {
        min: offset(e.position, e.center[0] - e.radius, e.center[1] - e.radius, 0),
        max: offset(e.position, e.center[0] + e.radius, e.center[1] + e.radius, 0),
      };
    case 'rectangle':
      // Origin at lower-left; extends +X (width), +Y (height).
      return { min: e.position, max: offset(e.position, e.width, e.height, 0) };
    case 'point':
      return { min: e.position, max: e.position };
    case 'ellipse':
      return {
        min: offset(e.position, e.center[0] - e.radiusX, e.center[1] - e.radiusY, 0),
        max: offset(e.position, e.center[0] + e.radiusX, e.center[1] + e.radiusY, 0),
      };
    case 'spline': {
      if (e.points.length === 0) return { min: e.position, max: e.position };
      const { minX, minY, maxX, maxY } = pointsExtent(e.points);
      return { min: offset(e.position, minX, minY, 0), max: offset(e.position, maxX, maxY, 0) };
    }
    case 'text': {
      // Estimated width using a monospace approximation: each glyph ≈ 0.6×height.
      const estimatedWidth = e.content.length * e.height * 0.6;
      return { min: e.position, max: offset(e.position, estimatedWidth, e.height, 0) };
    }
    case 'dimension': {
      // Dimensions have no own geometry — produce a small AABB around the entity position
      // using the offset (witness-line distance) as a proxy for the annotation extent.
      const ext = e.offset ?? 5;
      return { min: offset(e.position, -ext, -ext, 0), max: offset(e.position, ext, ext, 0) };
    }
    case 'instance': {
      // Instance bounds without component access: return a point at the instance position.
      // Callers with doc access should use instanceBoundsFromDoc() for accurate bounds.
      return { min: e.position, max: e.position };
    }
    default: {
      const exhaustive: never = e;
      return { min: (exhaustive as Entity).position, max: (exhaustive as Entity).position };
    }
  }
}

/**
 * Compute the world AABB of an InstanceEntity by expanding it against its component's
 * child entities. Callers that have access to the document should prefer this over
 * `entityBounds` for `instance` kind entities.
 *
 * Falls back to a point at the instance position when the component is empty or missing.
 *
 * @pure — reads only; does not mutate
 */
export function instanceBoundsFromDoc(instance: InstanceEntity, doc: CadDocument): Bounds {
  const component = doc.components[instance.componentId];
  if (!component || component.order.length === 0) {
    return { min: instance.position, max: instance.position };
  }

  const scale = instance.scale ?? ([1, 1, 1] as const);
  const [sx, sy, sz] = scale;
  const rot = instance.rotation;
  const pos = instance.position;
  const hasRotation = !isZeroRotation(rot);

  let combined: Bounds | null = null;

  for (const cid of component.order) {
    const child = component.entities[cid];
    if (!child) continue;

    const localBounds = entityBounds(child);
    const lMin = localBounds.min;
    const lMax = localBounds.max;
    const corners: Vec3[] = [
      [lMin[0], lMin[1], lMin[2]],
      [lMax[0], lMin[1], lMin[2]],
      [lMin[0], lMax[1], lMin[2]],
      [lMax[0], lMax[1], lMin[2]],
      [lMin[0], lMin[1], lMax[2]],
      [lMax[0], lMin[1], lMax[2]],
      [lMin[0], lMax[1], lMax[2]],
      [lMax[0], lMax[1], lMax[2]],
    ];

    for (const c of corners) {
      // Scale
      const scaled: Vec3 = [c[0] * sx, c[1] * sy, c[2] * sz];
      // Rotate around component origin
      const rotated: Vec3 = hasRotation ? applyEulerXYZ(scaled, [0, 0, 0], rot) : scaled;
      // Translate
      const world: Vec3 = [rotated[0] + pos[0], rotated[1] + pos[1], rotated[2] + pos[2]];

      if (!combined) {
        combined = { min: [world[0], world[1], world[2]], max: [world[0], world[1], world[2]] };
      } else {
        combined = {
          min: [
            Math.min(combined.min[0], world[0]),
            Math.min(combined.min[1], world[1]),
            Math.min(combined.min[2], world[2]),
          ],
          max: [
            Math.max(combined.max[0], world[0]),
            Math.max(combined.max[1], world[1]),
            Math.max(combined.max[2], world[2]),
          ],
        };
      }
    }
  }

  return combined ?? { min: instance.position, max: instance.position };
}

export function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}
