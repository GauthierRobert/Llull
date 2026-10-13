// 3D gizmo snapping: AABB corners / edge midpoints / face centres of solids (cylinder: disc + rim points, sphere: poles), then grid.

import { type Entity, type CadDocument, is3D } from '@core/model/types';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { nearestSnap } from '../nearestSnap';

export type Snap3DType = 'vertex' | 'edge' | 'face-center' | 'grid' | 'none';

export interface SnapPoint3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly type: Snap3DType;
}

interface SnapResult3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 'none' = raw cursor returned. */
  readonly type: Snap3DType;
  readonly snapped: boolean;
}

const SNAP3D_PRIORITY: Record<Snap3DType, number> = { vertex: 0, edge: 1, 'face-center': 2, grid: 3, none: 4 };

type Triple = readonly [number, number, number];

interface AABB {
  readonly min: Triple;
  readonly max: Triple;
}

/** World AABB (rotation applied) of a 3D solid; null for non-solids. */
function entityAABB(entity: Entity): AABB | null {
  return is3D(entity) ? rotatedEntityBounds(entity) : null;
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
  const corners = sides.flatMap((zs) => sides.flatMap((ys) => sides.map((xs) => point([xs[0], ys[1], zs[2]], 'vertex'))));
  const faces = [0, 1, 2].flatMap((axis) => sides.map((side) => point(onSides([[axis, side]]), 'face-center')));
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
    const [x, y, z] = entityLocalToWorld(entity, offset);
    return { x, y, z, type: 'vertex' };
  });
}

/** Axis +Z, centred on position: both disc centres + 8 rim points per disc. */
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

/** Centre + 6 axis poles. */
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

/** World snap points of every 3D entity except `excludeId`. */
export function collectSnapCandidates3D(document: CadDocument, excludeId: string | undefined): SnapPoint3D[] {
  const candidates: SnapPoint3D[] = [];
  for (const id of document.order) {
    const entity = id === excludeId ? undefined : document.entities[id];
    if (!entity || !is3D(entity)) continue;
    if (entity.kind === 'cylinder') candidates.push(...cylinderSnapPoints(entity));
    else if (entity.kind === 'sphere') candidates.push(...sphereSnapPoints(entity));
    else {
      const bb = entityAABB(entity);
      if (bb) candidates.push(...aabbSnapPoints(bb));
    }
  }

  return candidates;
}

/** Nearest candidate within tolerance (ties: vertex > edge > face-center), else the grid point, else 'none' (gridStep <= 0). */
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

  if (best !== null) return { x: best.x, y: best.y, z: best.z, type: best.type, snapped: true };

  if (gridStep > 0) {
    const round = (v: number): number => Math.round(v / gridStep) * gridStep;
    return { x: round(candidateX), y: round(candidateY), z: round(candidateZ), type: 'grid', snapped: true };
  }

  return { x: candidateX, y: candidateY, z: candidateZ, type: 'none', snapped: false };
}
