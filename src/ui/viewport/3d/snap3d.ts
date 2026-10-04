/**
 * @layer ui/viewport/3d
 * @pure Object snapping for the transform gizmo: AABB corners/face centres/edge midpoints of
 * solids (cylinder and sphere use disc/pole points), then grid fallback.
 */

import type { Entity, CadDocument } from '@core/model/types';
import { is3D } from '@core/model/types';

export type Snap3DType = 'vertex' | 'edge' | 'face-center' | 'grid' | 'none';

export interface SnapPoint3D {
  /** World-space position. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly type: Snap3DType;
}

interface SnapResult3D {
  /** The snapped world position. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Which snap type was used. 'none' means raw cursor position was returned. */
  readonly type: Snap3DType;
  /** True when a snap (geometric or grid) was applied. */
  readonly snapped: boolean;
}

const SNAP3D_PRIORITY: Record<Snap3DType, number> = {
  vertex: 0,
  edge: 1,
  'face-center': 2,
  grid: 3,
  none: 4,
};

type Triple = readonly [number, number, number];

/** World-space axis-aligned bounds. */
interface AABB {
  readonly min: Triple;
  readonly max: Triple;
}

function boundsOf(points: ReadonlyArray<Triple>): AABB | null {
  if (points.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] ?? Infinity, point[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, point[axis] ?? 0);
    }
  }
  return { min, max };
}

/** World AABB of a 3D solid (rotation ignored); null for kinds without one. */
function entityAABB(entity: Entity): AABB | null {
  const [px, py, pz] = entity.position;
  switch (entity.kind) {
    case 'box': {
      const [w, h, d] = entity.size;
      return {
        min: [px - w / 2, py - h / 2, pz - d / 2],
        max: [px + w / 2, py + h / 2, pz + d / 2],
      };
    }
    case 'cylinder': {
      const { radius, height } = entity;
      return { min: [px - radius, py, pz - radius], max: [px + radius, py + height, pz + radius] };
    }
    case 'sphere': {
      const { radius } = entity;
      return {
        min: [px - radius, py - radius, pz - radius],
        max: [px + radius, py + radius, pz + radius],
      };
    }
    case 'extrusion': {
      const bounds = boundsOf(entity.profile.map(([lx, lz]) => [lx, 0, lz]));
      if (bounds === null) return null;
      return {
        min: [px + bounds.min[0], py, pz + bounds.min[2]],
        max: [px + bounds.max[0], py + entity.depth, pz + bounds.max[2]],
      };
    }
    case 'mesh': {
      const { positions } = entity.mesh;
      const vertices: Triple[] = [];
      for (let i = 0; i + 2 < positions.length; i += 3) {
        vertices.push([positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0]);
      }
      return boundsOf(vertices);
    }
    default:
      return null;
  }
}

/** The 8 corners (x varies fastest), 6 face centres and 12 edge midpoints of an AABB. */
function aabbSnapPoints({ min, max }: AABB): SnapPoint3D[] {
  const sides = [min, max];
  const center: Triple = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const point = ([x, y, z]: Triple, type: Snap3DType): SnapPoint3D => ({ x, y, z, type });
  /** `center` with the listed axes moved onto the given sides. */
  const onSides = (moves: ReadonlyArray<readonly [axis: number, side: Triple]>): Triple => {
    const p: [number, number, number] = [...center];
    for (const [axis, side] of moves) p[axis] = side[axis] ?? 0;
    return p;
  };
  const corners = sides.flatMap((zs) =>
    sides.flatMap((ys) => sides.map((xs) => point([xs[0], ys[1], zs[2]], 'vertex'))),
  );
  const faces = [0, 1, 2].flatMap((axis) =>
    sides.map((side) => point(onSides([[axis, side]]), 'face-center')),
  );
  const edges = [0, 1, 2].flatMap((axis) => {
    const [a = 0, b = 0] = [0, 1, 2].filter((other) => other !== axis);
    return sides.flatMap((bSide) =>
      sides.map((aSide) =>
        point(
          onSides([
            [a, aSide],
            [b, bSide],
          ]),
          'edge',
        ),
      ),
    );
  });
  return [...corners, ...faces, ...edges];
}

/** Cylinder: both disc centres plus 8 rim points on each disc, all 'vertex'. */
function cylinderSnapPoints(entity: Entity & { kind: 'cylinder' }): SnapPoint3D[] {
  const [px, py, pz] = entity.position;
  const { radius, height } = entity;
  const points: SnapPoint3D[] = [
    { x: px, y: py, z: pz, type: 'vertex' },
    { x: px, y: py + height, z: pz, type: 'vertex' },
  ];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * 2 * Math.PI;
    const x = px + Math.cos(angle) * radius;
    const z = pz + Math.sin(angle) * radius;
    points.push({ x, y: py, z, type: 'vertex' }, { x, y: py + height, z, type: 'vertex' });
  }
  return points;
}

/** Sphere: centre plus 6 axis-aligned poles, all 'vertex'. */
function sphereSnapPoints(entity: Entity & { kind: 'sphere' }): SnapPoint3D[] {
  const [px, py, pz] = entity.position;
  const { radius: r } = entity;
  return [
    [0, 0, 0],
    [r, 0, 0],
    [-r, 0, 0],
    [0, r, 0],
    [0, -r, 0],
    [0, 0, r],
    [0, 0, -r],
  ].map(([dx, dy, dz]) => ({
    x: px + (dx ?? 0),
    y: py + (dy ?? 0),
    z: pz + (dz ?? 0),
    type: 'vertex',
  }));
}

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

    const bb = entityAABB(entity);
    if (bb) candidates.push(...aabbSnapPoints(bb));
  }

  return candidates;
}

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
    const d = Math.hypot(pt.x - candidateX, pt.y - candidateY, pt.z - candidateZ);
    if (d <= tolerance) {
      const beatsByDist = d < bestDist - 1e-10;
      const sameDist = Math.abs(d - bestDist) <= 1e-10;
      const beatsByPriority =
        sameDist && best !== null && SNAP3D_PRIORITY[pt.type] < SNAP3D_PRIORITY[best.type];

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
