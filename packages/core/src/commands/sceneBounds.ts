import type { CadDocument, Entity, InstanceEntity, Vec3 } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { ORIGIN, add3, sub3 } from '../lib/vec3';
import { type Bounds } from './sceneTypes';

/** Min/max of a flat xyz position array (`[x0, y0, z0, x1, ...]`); needs at least one full triple. */
function positionsExtent(positions: readonly number[]): { min: Vec3; max: Vec3 } {
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

const bounds = (min: Vec3, max: Vec3): Bounds => ({ min, max });

/** Axis-aligned box centered on the origin. */
const centered = (x: number, y: number, z: number): Bounds => bounds([-x, -y, -z], [x, y, z]);

/** Local-space AABB of a `mesh`: its world-space positions re-expressed relative to `position`. */
function meshLocalBounds(e: Extract<Entity, { kind: 'mesh' }>): Bounds {
  const p = e.mesh.positions;
  if (p.length < 3) return bounds(ORIGIN, ORIGIN);
  const { min, max } = positionsExtent(p);
  return bounds(sub3(min, e.position), sub3(max, e.position));
}

/**
 * AABB of one entity in its own frame (before `rotation` / `position`), matching how the
 * viewport places each kind. Mesh positions are world-space, so their local bounds are
 * relative to `position`.
 */
export function localBounds(e: Entity): Bounds {
  switch (e.kind) {
    case 'box':
      return centered(e.size[0] / 2, e.size[1] / 2, e.size[2] / 2);
    case 'cylinder':
      // Z-up: axis along Z, centered at position (matches render.ts / export.ts).
      return centered(e.radius, e.radius, e.height / 2);
    case 'sphere':
      return centered(e.radius, e.radius, e.radius);
    case 'extrusion': {
      // ExtrudeGeometry extrudes along +Z from the profile plane.
      const { minX, minY, maxX, maxY } = pointsExtent(e.profile);
      return bounds([minX, minY, 0], [maxX, maxY, e.depth]);
    }
    case 'mesh':
      return meshLocalBounds(e);
    case 'cone':
      // Base circle in XY; apex at +height in Z.
      return bounds([-e.radius, -e.radius, 0], [e.radius, e.radius, e.height]);
    case 'torus': {
      // Ring in XY: outer extent is ringRadius+tubeRadius; tube extends ±tubeRadius in Z.
      const outer = e.ringRadius + e.tubeRadius;
      return centered(outer, outer, e.tubeRadius);
    }
    case 'wedge':
      // Lower-front-left corner at position; extends +X/+Y/+Z by size.
      return bounds(ORIGIN, e.size);
    case 'pyramid':
      return bounds(
        [-e.baseWidth / 2, -e.baseDepth / 2, 0],
        [e.baseWidth / 2, e.baseDepth / 2, e.height],
      );
    case 'revolution': {
      // Conservative: radial extent around the world axis closest to `axis`, axial extent from the profile.
      const maxR = e.profile.reduce((m, [x]) => Math.max(m, Math.abs(x)), 0);
      const minAxial = Math.min(...e.profile.map(([, y]) => y));
      const maxAxial = Math.max(...e.profile.map(([, y]) => y));
      const [abx, aby, abz] = e.axis.map(Math.abs) as [number, number, number];
      if (abz >= abx && abz >= aby) return bounds([-maxR, -maxR, minAxial], [maxR, maxR, maxAxial]);
      if (aby >= abx) return bounds([-maxR, minAxial, -maxR], [maxR, maxAxial, maxR]);
      return bounds([minAxial, -maxR, -maxR], [maxAxial, maxR, maxR]);
    }
    case 'line': {
      const { minX, minY, maxX, maxY } = pointsExtent([e.start, e.end]);
      return bounds([minX, minY, 0], [maxX, maxY, 0]);
    }
    case 'polyline':
    case 'spline': {
      const { minX, minY, maxX, maxY } = pointsExtent(e.points);
      return bounds([minX, minY, 0], [maxX, maxY, 0]);
    }
    case 'arc':
    case 'circle':
      // Conservative: full center±radius box (arcs are not angle-trimmed here).
      return bounds(
        [e.center[0] - e.radius, e.center[1] - e.radius, 0],
        [e.center[0] + e.radius, e.center[1] + e.radius, 0],
      );
    case 'rectangle':
      // Origin at lower-left; extends +X (width), +Y (height).
      return bounds(ORIGIN, [e.width, e.height, 0]);
    case 'ellipse':
      return bounds(
        [e.center[0] - e.radiusX, e.center[1] - e.radiusY, 0],
        [e.center[0] + e.radiusX, e.center[1] + e.radiusY, 0],
      );
    case 'text':
      // Monospace estimate: each glyph ≈ 0.6×height wide.
      return bounds(ORIGIN, [e.content.length * e.height * 0.6, e.height, 0]);
    case 'dimension': {
      // No own geometry: a small box sized by the witness-line offset.
      const ext = e.offset ?? 5;
      return bounds([-ext, -ext, 0], [ext, ext, 0]);
    }
    case 'point':
    case 'instance':
      // Instances need the document for real bounds: use `instanceBoundsFromDoc`.
      return bounds(ORIGIN, ORIGIN);
  }
}

/** World-space AABB of one entity, matching how the viewport places each kind. */
export function entityBounds(e: Entity): Bounds {
  if (e.kind === 'mesh') {
    // Mesh positions are already world-space.
    const p = e.mesh.positions;
    return p.length < 3 ? bounds(e.position, e.position) : positionsExtent(p);
  }
  const { min, max } = localBounds(e);
  return bounds(add3(e.position, min), add3(e.position, max));
}

/** The 8 corners of an AABB. */
export function boundsCorners({ min, max }: Bounds): Vec3[] {
  return [min[2], max[2]].flatMap((z) => [
    [min[0], min[1], z] as Vec3,
    [max[0], min[1], z] as Vec3,
    [max[0], max[1], z] as Vec3,
    [min[0], max[1], z] as Vec3,
  ]);
}

/** Tight AABB of a non-empty point set. */
export function boundsOfPoints(points: readonly Vec3[]): Bounds {
  const { min, max } = positionsExtent(points.flat());
  return { min, max };
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

  const { scale = [1, 1, 1], rotation, position } = instance;
  const hasRotation = !isZeroRotation(rotation);

  const worldPoints: Vec3[] = [];
  for (const cid of component.order) {
    const child = component.entities[cid];
    if (!child) continue;
    for (const c of boundsCorners(entityBounds(child))) {
      const scaled: Vec3 = [c[0] * scale[0], c[1] * scale[1], c[2] * scale[2]];
      // Rotate around the component origin, then translate.
      const rotated = hasRotation ? applyEulerXYZ(scaled, ORIGIN, rotation) : scaled;
      worldPoints.push(add3(rotated, position));
    }
  }
  return worldPoints.length > 0 ? boundsOfPoints(worldPoints) : bounds(position, position);
}

/** True when two AABBs overlap (touching counts) on every axis. */
export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/** Centre of an AABB. */
export function boundsCenter({ min, max }: Bounds): Vec3 {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/** Largest side of an AABB. */
export function boundsExtent({ min, max }: Bounds): number {
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** Radius of the sphere framing `bounds`: half the largest extent, 1 for a (near-)point scene. */
export function boundsRadius(bounds: Bounds): number {
  const radius = boundsExtent(bounds) / 2 + 1e-3;
  return radius < 0.1 ? 1 : radius;
}

export function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}
