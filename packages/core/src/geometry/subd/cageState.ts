/** Editable form of a subdivision entity's cage for topology operations (04 DIR §5.3): plain arrays, one sharpness list, element ids. */

import type { SubdivisionEntity, Vec3 } from '../../model/types';
import type { CageElementIds } from '../../model/subdivisionCage';
import { edgeSharpnessMap, partitionSharpness, SHARP_MAX } from './sharpness';

export interface CageState {
  readonly vertices: Vec3[];
  readonly faces: number[][];
  readonly vertexIds: string[];
  readonly faceIds: string[];
  /** Every sharp edge as [a, b, sharpness]; 10 = infinite. */
  readonly sharp: Array<readonly [number, number, number]>;
  readonly corners: Array<{ readonly v: number; readonly s: number }>;
}

/** The mutable working copy of `entity`'s cage. */
export function cageState(
  entity: Pick<SubdivisionEntity, 'vertices' | 'faces' | 'creases' | 'edgeSharpness' | 'vertexSharpness' | 'elementIds'>,
): CageState {
  const sharp = [...edgeSharpnessMap(entity)].map(([key, s]): readonly [number, number, number] => {
    const [a, b] = key.split(':').map(Number) as [number, number];
    return [a, b, s];
  });
  return {
    vertices: entity.vertices.map((p): Vec3 => [p[0], p[1], p[2]]),
    faces: entity.faces.map((face) => [...face]),
    vertexIds: [...entity.elementIds.vertices],
    faceIds: [...entity.elementIds.faces],
    sharp,
    corners: (entity.vertexSharpness ?? []).map(({ v, s }) => ({ v, s: Math.min(SHARP_MAX, s) })),
  };
}

/** `entity` with its cage replaced by `state` (sharpness partitioned into `creases` / `edgeSharpness`; symmetry cleared unless given). */
export function withCageState(
  entity: SubdivisionEntity,
  state: CageState,
  symmetry: SubdivisionEntity['symmetry'] = undefined,
): SubdivisionEntity {
  const { creases, edgeSharpness } = partitionSharpness(state.sharp);
  const rest: Record<string, unknown> = { ...entity };
  for (const key of ['edgeSharpness', 'vertexSharpness', 'symmetry']) delete rest[key];
  const elementIds: CageElementIds = { vertices: state.vertexIds, faces: state.faceIds };
  return {
    ...(rest as unknown as SubdivisionEntity),
    vertices: state.vertices,
    faces: state.faces,
    creases,
    ...(edgeSharpness.length > 0 ? { edgeSharpness } : {}),
    ...(state.corners.length > 0 ? { vertexSharpness: state.corners } : {}),
    ...(symmetry !== undefined ? { symmetry } : {}),
    elementIds,
  };
}
