/** NURBS curves and sheets in world coordinates: the entity poles are local to its position and rotation. */

import type { MeshSolidEntity, NurbsCurveEntity, NurbsSurfaceEntity } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { applyEulerXYZ, isZeroRotation } from '../../lib/eulerRotation';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { mapPoles, mapSurfacePoles } from './curveWarp';

const place =
  (entity: NurbsCurveEntity | NurbsSurfaceEntity | MeshSolidEntity): ((pole: Vec3) => Vec3) =>
  (pole) => {
    const { position, rotation } = entity;
    const moved: Vec3 = [pole[0] + position[0], pole[1] + position[1], pole[2] + position[2]];
    return isZeroRotation(rotation) ? moved : applyEulerXYZ(moved, position, rotation);
  };

/** The curve of `entity` in world coordinates. */
export const worldCurve = (entity: NurbsCurveEntity): NurbsCurveData => mapPoles(entity.curve, place(entity));

/** The sheet of `entity` in world coordinates. */
export const worldSurface = (entity: NurbsSurfaceEntity): NurbsSurfaceData => mapSurfacePoles(entity.surface, place(entity));

/** The vertices of a mesh entity in world coordinates (flat xyz). */
export function worldMeshPositions(entity: MeshSolidEntity): number[] {
  const to = place(entity);
  const out: number[] = [];
  for (let k = 0; k + 2 < entity.mesh.positions.length; k += 3)
    out.push(...to([entity.mesh.positions[k] as number, entity.mesh.positions[k + 1] as number, entity.mesh.positions[k + 2] as number]));
  return out;
}
