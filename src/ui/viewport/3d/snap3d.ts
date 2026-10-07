/**
 * @layer ui/viewport/3d
 * @pure Object snapping for the transform gizmo: AABB corners/face centres/edge midpoints of
 * solids (cylinder and sphere use disc/pole points), then grid fallback.
 */

import type { Entity, CadDocument } from '@core/model/types';
import { is3D } from '@core/model/types';
import { rotatedEntityBounds } from '@core/commands/sceneRotatedBounds';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { nearestSnap } from '../nearestSnap';

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

/** World AABB (rotation applied) of a 3D solid; null for non-solids. */
function entityAABB(entity: Entity): AABB | null {
  if (!is3D(entity)) return null;
  const { min, max } = rotatedEntityBounds(entity);
  return { min, max };
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

/** Local (Z-up, pre-rotation) offsets placed in world space about the entity position. */
function worldPoints(entity: Entity, offsets: ReadonlyArray<Triple>): SnapPoint3D[] {
  return offsets.map((offset) => {
    const [x, y, z] = applyEulerXYZ(
      [
        entity.position[0] + offset[0],
        entity.position[1] + offset[1],
        entity.position[2] + offset[2],
      ],
      entity.position,
      entity.rotation,
    );
    return { x, y, z, type: 'vertex' };
  });
}

/** Cylinder (axis +Z, centred on position): both disc centres plus 8 rim points on each disc. */
function cylinderSnapPoints(entity: Entity & { kind: 'cylinder' }): SnapPoint3D[] {
  const { radius, height } = entity;
  const half = height / 2;
  const offsets: Triple[] = [
    [0, 0, -half],
    [0, 0, half],
  ];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * 2 * Math.PI;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    offsets.push([x, y, -half], [x, y, half]);
  }
  return worldPoints(entity, offsets);
}

/** Sphere: centre plus 6 axis-aligned poles, all 'vertex'. */
function sphereSnapPoints(entity: Entity & { kind: 'sphere' }): SnapPoint3D[] {
  const r = entity.radius;
  return worldPoints(entity, [
    [0, 0, 0],
    [r, 0, 0],
    [-r, 0, 0],
    [0, r, 0],
    [0, -r, 0],
    [0, 0, r],
    [0, 0, -r],
  ]);
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
  const best = nearestSnap(
    candidates,
    (point) => Math.hypot(point.x - candidateX, point.y - candidateY, point.z - candidateZ),
    tolerance,
    SNAP3D_PRIORITY,
  );

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
