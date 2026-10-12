/**
 * Shared helpers for gear/shaft commands that emit world-space `mesh` solids.
 *
 * @layer core/commands
 */

import type { Entity, MeshData, Vec3 } from '../../model/types';
import { placeMesh } from '../../geometry/prismMesh';
import { newEntity } from '../entity/newEntity';

/** Euler rotation taking the local +Z gear axis to the world axis. */
export const AXIS_ROTATION: Readonly<Record<'x' | 'y' | 'z', Vec3>> = {
  x: [0, Math.PI / 2, 0],
  y: [-Math.PI / 2, 0, 0],
  z: [0, 0, 0],
};

/** Local-frame mesh → world-space `mesh` entity (position/rotation baked, entity transform identity). */
export function meshGearEntity(
  id: string,
  mesh: MeshData,
  color: string,
  name: string | undefined,
): Entity {
  return newEntity('mesh', id, { mesh }, [0, 0, 0], color, { name });
}

/** Bakes `position` + extrinsic-XYZ `rotation` into the local mesh and wraps it as an entity. */
export function placedMeshEntity(
  id: string,
  local: MeshData,
  position: Vec3,
  rotation: Vec3,
  color: string,
  name: string | undefined,
): Entity {
  return meshGearEntity(id, placeMesh(local, position, rotation), color, name);
}
