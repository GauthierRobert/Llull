/** Shared helpers for gear/shaft commands that emit world-space `mesh` solids. */

import type { Entity, MeshData, Vec3 } from '../../model/types';
import { placeMesh } from '../../geometry/prismMesh';
import { newEntity } from '../entity/newEntity';
import { MAX_GEAR_TEETH } from '../limits';

/** Euler rotation taking the local +Z gear axis to the world axis. */
export const AXIS_ROTATION: Readonly<Record<'x' | 'y' | 'z', Vec3>> = { x: [0, Math.PI / 2, 0], y: [-Math.PI / 2, 0, 0], z: [0, 0, 0] };

/** Why `mod` is not a usable gear module, or `null` when it is. */
export function moduleProblem(mod: number): string | null {
  return mod > 0 && Number.isFinite(mod) ? null : `module must be finite and > 0, got ${String(mod)}.`;
}

/** Why tooth count `count` (named `label`) is not an integer in [`min`, MAX_GEAR_TEETH], else null; `shown` is the value quoted. */
export function teethCountProblem(label: string, count: number, min: number, shown: unknown = count): string | null {
  return Number.isInteger(count) && count >= min && count <= MAX_GEAR_TEETH
    ? null
    : `${label} must be an integer in [${min}, ${MAX_GEAR_TEETH}], got ${String(shown)}.`;
}

/** Why `pressureAngle` (radians) is not a usable gear pressure angle, or `null` when it is. */
export function pressureAngleProblem(pressureAngle: number): string | null {
  return pressureAngle > 0 && pressureAngle < Math.PI / 2 ? null : `pressureAngle must be in (0, π/2), got ${String(pressureAngle)}.`;
}

/** First failing check of `pressureAngle` then `faceWidth`, or `null` when both pass. */
export function toothShapeProblem(pressureAngle: number, faceWidth: number): string | null {
  return (
    pressureAngleProblem(pressureAngle) ??
    (faceWidth > 0 && Number.isFinite(faceWidth) ? null : `faceWidth must be finite and > 0, got ${String(faceWidth)}.`)
  );
}

/** Bakes `position` + extrinsic-XYZ `rotation` into the local mesh → world-space `mesh` entity (entity transform identity). */
export function placedMeshEntity(
  id: string,
  local: MeshData,
  position: Vec3,
  rotation: Vec3,
  color: string,
  name: string | undefined,
): Entity {
  return newEntity('mesh', id, { mesh: placeMesh(local, position, rotation) }, [0, 0, 0], color, { name });
}
