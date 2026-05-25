/**
 * @layer ui/viewport/3d
 *
 * Pure 3D object-snapping helpers for the transform gizmo.
 *
 * Given a candidate world point + scene entities (described by their world-space
 * AABB key points) + a tolerance, returns the nearest snap point and its type.
 *
 * Key points derived per solid kind:
 *   - box/extrusion  : 8 AABB corners + 6 face centres + 12 edge midpoints
 *   - cylinder       : top & bottom disc centres + 8 rim points on each disc
 *   - sphere         : centre + 6 axis-aligned poles
 *   - mesh           : 8 AABB corners + 6 face centres (mesh vertices not traversed)
 *
 * Grid snap: round to the nearest gridStep on all three axes.
 *
 * All functions are deterministic and side-effect free.
 * No React, no three.js, no store reads — pure TypeScript.
 *
 * Unit-tested in tests/unit/snap3d.test.ts.
 *
 * @pure
 */

import type { Entity, CadDocument } from '@core/model/types';
import { is3D } from '@core/model/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Snap3DType = 'vertex' | 'edge' | 'face-center' | 'grid' | 'none';

export interface SnapPoint3D {
  /** World-space position. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly type: Snap3DType;
}

export interface SnapResult3D {
  /** The snapped world position. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Which snap type was used. 'none' means raw cursor position was returned. */
  readonly type: Snap3DType;
  /** True when a snap (geometric or grid) was applied. */
  readonly snapped: boolean;
}

// ---------------------------------------------------------------------------
// Priority order — lower index = higher priority
// ---------------------------------------------------------------------------

const SNAP3D_PRIORITY: Record<Snap3DType, number> = {
  vertex: 0,
  edge: 1,
  'face-center': 2,
  grid: 3,
  none: 4,
};

// ---------------------------------------------------------------------------
// Internal geometry helpers
// ---------------------------------------------------------------------------

/** Euclidean distance between two 3D points. */
function dist3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// AABB helpers
// ---------------------------------------------------------------------------

/**
 * Axis-aligned bounding box defined by its min/max corners.
 * All in world space.
 */
interface AABB {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

/**
 * Derive an entity's world-space AABB.
 * For 3D solids only — returns null for 2D shapes.
 * Ignores entity rotation (uses axis-aligned bounds from entity position + size params).
 *
 * @pure
 */
function entityAABB(entity: Entity): AABB | null {
  const [px, py, pz] = entity.position;

  switch (entity.kind) {
    case 'box': {
      const [w, h, d] = entity.size;
      // Box is centred at position.
      return {
        minX: px - w / 2, maxX: px + w / 2,
        minY: py - h / 2, maxY: py + h / 2,
        minZ: pz - d / 2, maxZ: pz + d / 2,
      };
    }
    case 'cylinder': {
      const { radius, height } = entity;
      return {
        minX: px - radius, maxX: px + radius,
        minY: py,          maxY: py + height,
        minZ: pz - radius, maxZ: pz + radius,
      };
    }
    case 'sphere': {
      const { radius } = entity;
      return {
        minX: px - radius, maxX: px + radius,
        minY: py - radius, maxY: py + radius,
        minZ: pz - radius, maxZ: pz + radius,
      };
    }
    case 'extrusion': {
      const { profile, depth } = entity;
      if (profile.length === 0) return null;
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (const [lx, lz] of profile) {
        if (lx < minX) minX = lx;
        if (lx > maxX) maxX = lx;
        if (lz < minZ) minZ = lz;
        if (lz > maxZ) maxZ = lz;
      }
      return {
        minX: px + minX, maxX: px + maxX,
        minY: py,        maxY: py + depth,
        minZ: pz + minZ, maxZ: pz + maxZ,
      };
    }
    case 'mesh': {
      // Derive AABB from mesh vertices.
      const { positions } = entity.mesh;
      if (positions.length < 3) return null;
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        const vx = positions[i]   ?? 0;
        const vy = positions[i+1] ?? 0;
        const vz = positions[i+2] ?? 0;
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
      }
      return { minX, maxX, minY, maxY, minZ, maxZ };
    }
    default:
      return null;
  }
}

/**
 * Expand an AABB's 8 corners into world-space snap candidates of type 'vertex'.
 *
 * @pure
 */
function aabbCorners(bb: AABB): Array<[number, number, number]> {
  const { minX, maxX, minY, maxY, minZ, maxZ } = bb;
  return [
    [minX, minY, minZ], [maxX, minY, minZ],
    [minX, maxY, minZ], [maxX, maxY, minZ],
    [minX, minY, maxZ], [maxX, minY, maxZ],
    [minX, maxY, maxZ], [maxX, maxY, maxZ],
  ];
}

/**
 * Expand an AABB's 6 face centres into snap candidates of type 'face-center'.
 *
 * @pure
 */
function aabbFaceCenters(bb: AABB): Array<[number, number, number]> {
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const cz = (bb.minZ + bb.maxZ) / 2;
  return [
    [bb.minX, cy, cz], [bb.maxX, cy, cz], // -X / +X face
    [cx, bb.minY, cz], [cx, bb.maxY, cz], // -Y / +Y face
    [cx, cy, bb.minZ], [cx, cy, bb.maxZ], // -Z / +Z face
  ];
}

/**
 * Expand an AABB's 12 edge midpoints into snap candidates of type 'edge'.
 * An axis-aligned box has 12 edges — 4 per axis direction.
 *
 * @pure
 */
function aabbEdgeMidpoints(bb: AABB): Array<[number, number, number]> {
  const { minX, maxX, minY, maxY, minZ, maxZ } = bb;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  return [
    // Edges along X axis (constant Y, Z)
    [cx, minY, minZ], [cx, maxY, minZ],
    [cx, minY, maxZ], [cx, maxY, maxZ],
    // Edges along Y axis (constant X, Z)
    [minX, cy, minZ], [maxX, cy, minZ],
    [minX, cy, maxZ], [maxX, cy, maxZ],
    // Edges along Z axis (constant X, Y)
    [minX, minY, cz], [maxX, minY, cz],
    [minX, maxY, cz], [maxX, maxY, cz],
  ];
}

// ---------------------------------------------------------------------------
// Per-kind key point extraction
// ---------------------------------------------------------------------------

/**
 * Cylinder snap points: top & bottom disc centres (vertex) +
 * 8 rim points on each disc at 45° increments (vertex).
 *
 * @pure
 */
function cylinderSnapPoints(entity: Entity & { kind: 'cylinder' }): SnapPoint3D[] {
  const [px, py, pz] = entity.position;
  const { radius, height } = entity;
  const pts: SnapPoint3D[] = [];

  // Disc centres.
  pts.push({ x: px, y: py,          z: pz, type: 'vertex' });
  pts.push({ x: px, y: py + height, z: pz, type: 'vertex' });

  // 8 rim points per disc (every 45°).
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * 2 * Math.PI;
    const rx = Math.cos(angle) * radius;
    const rz = Math.sin(angle) * radius;
    pts.push({ x: px + rx, y: py,          z: pz + rz, type: 'vertex' });
    pts.push({ x: px + rx, y: py + height, z: pz + rz, type: 'vertex' });
  }

  return pts;
}

/**
 * Sphere snap points: centre + 6 axis-aligned poles.
 *
 * @pure
 */
function sphereSnapPoints(entity: Entity & { kind: 'sphere' }): SnapPoint3D[] {
  const [px, py, pz] = entity.position;
  const { radius } = entity;
  return [
    { x: px,          y: py,          z: pz,          type: 'vertex' }, // centre
    { x: px + radius, y: py,          z: pz,          type: 'vertex' }, // +X
    { x: px - radius, y: py,          z: pz,          type: 'vertex' }, // -X
    { x: px,          y: py + radius, z: pz,          type: 'vertex' }, // +Y
    { x: px,          y: py - radius, z: pz,          type: 'vertex' }, // -Y
    { x: px,          y: py,          z: pz + radius, type: 'vertex' }, // +Z
    { x: px,          y: py,          z: pz - radius, type: 'vertex' }, // -Z
  ];
}

// ---------------------------------------------------------------------------
// collectSnapCandidates3D
// ---------------------------------------------------------------------------

/**
 * Derive all 3D snap candidate points from solid entities in a document.
 * Returns world-space 3D snap points for all 3D entities except the one
 * being dragged (identified by `excludeId`).
 *
 * @pure deterministic, no side effects
 * @invariant Returns [] when document has no 3D entities (or only the excluded one).
 */
export function collectSnapCandidates3D(
  document: CadDocument,
  excludeId: string | undefined,
): SnapPoint3D[] {
  const candidates: SnapPoint3D[] = [];

  for (const id of document.order) {
    if (id === excludeId) continue;
    const entity = document.entities[id];
    if (!entity || !is3D(entity)) continue;

    if (entity.kind === 'cylinder') {
      candidates.push(...cylinderSnapPoints(entity));
      continue;
    }

    if (entity.kind === 'sphere') {
      candidates.push(...sphereSnapPoints(entity));
      continue;
    }

    // For box, extrusion, mesh: derive from AABB.
    const bb = entityAABB(entity);
    if (!bb) continue;

    for (const [x, y, z] of aabbCorners(bb)) {
      candidates.push({ x, y, z, type: 'vertex' });
    }
    for (const [x, y, z] of aabbFaceCenters(bb)) {
      candidates.push({ x, y, z, type: 'face-center' });
    }
    for (const [x, y, z] of aabbEdgeMidpoints(bb)) {
      candidates.push({ x, y, z, type: 'edge' });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// snap3d
// ---------------------------------------------------------------------------

/**
 * Find the best 3D snap for a candidate world position.
 *
 * Priority: vertex > edge > face-center > grid.
 * When multiple candidates share the minimum distance, lower-priority type is beaten.
 * Falls back to the nearest grid point (rounded to gridStep on all axes) when no
 * geometric candidate is within tolerance. When gridStep <= 0 and no geometric snap
 * is found, returns the raw candidate position with type 'none'.
 *
 * @pure deterministic, no side effects
 * @invariant Does not mutate the candidates array or the candidate positions.
 */
export function snap3d(
  candidateX: number,
  candidateY: number,
  candidateZ: number,
  candidates: ReadonlyArray<SnapPoint3D>,
  tolerance: number,
  gridStep: number,
): SnapResult3D {
  let bestDist = Infinity;
  let best: SnapPoint3D | null = null;

  for (const pt of candidates) {
    const d = dist3(candidateX, candidateY, candidateZ, pt.x, pt.y, pt.z);
    if (d <= tolerance) {
      const beatsByDist = d < bestDist - 1e-10;
      const sameDist = Math.abs(d - bestDist) <= 1e-10;
      const beatsByPriority =
        sameDist &&
        best !== null &&
        SNAP3D_PRIORITY[pt.type] < SNAP3D_PRIORITY[best.type];

      if (beatsByDist || beatsByPriority) {
        bestDist = d;
        best = pt;
      }
    }
  }

  if (best !== null) {
    return { x: best.x, y: best.y, z: best.z, type: best.type, snapped: true };
  }

  // Grid fallback.
  if (gridStep > 0) {
    const gx = Math.round(candidateX / gridStep) * gridStep;
    const gy = Math.round(candidateY / gridStep) * gridStep;
    const gz = Math.round(candidateZ / gridStep) * gridStep;
    return { x: gx, y: gy, z: gz, type: 'grid', snapped: true };
  }

  return { x: candidateX, y: candidateY, z: candidateZ, type: 'none', snapped: false };
}
