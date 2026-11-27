/** Shared by the scene-object commands: refusal codes, aim resolution, explicit-layer fallback. */

import type { Vec3 } from '../../model/types';
import { isVec3, sub3 } from '../../lib/vec3';
import { lookAtEuler } from '../../lib/lookAt';
import { tableRejection } from '../noop';

export const SCENE_REMEDIATION: Readonly<Record<string, string>> = {
  SCENE_LIGHT_INVALID:
    'Give finite position / target, a target different from position, intensity >= 0, a #rrggbb color, a spot coneAngle in (0, pi/2] and blend in [0, 1], an area width and height > 0.',
  SCENE_CAMERA_INVALID:
    'Give finite position / target, a target different from position, and focalLength, sensorWidth, sensorHeight, focusDistance, fStop all > 0.',
  SCENE_OBJECT_NOT_FOUND: 'Run `llull describe_scene` (or find_entities kind "light" / "camera") to list the ids.',
  SCENE_CAMERA_NOT_FOUND: 'Run find_entities with kind "camera" to list camera ids; add_camera creates one.',
  SCENE_NOT_A_CAMERA: 'Pass the id of a camera entity (add_camera), not of another kind.',
};

export const sceneRejection = tableRejection(SCENE_REMEDIATION);

/**
 * Stored rotation of a scene object: local -Z aimed at `target` (a point), else the given `rotation`, else straight down (-Z).
 * @failure non-finite position / target / rotation, or a target equal to the position -> error text
 */
export function resolveAim(
  position: Vec3,
  target: readonly number[] | undefined,
  rotation: readonly number[] | undefined,
): { readonly rotation: Vec3; readonly error?: undefined } | { readonly error: string } {
  if (!isVec3(position)) return { error: `position must be 3 finite numbers, got ${JSON.stringify(position)}` };
  if (target !== undefined) {
    if (!isVec3(target)) return { error: `target must be 3 finite numbers [x, y, z], got ${JSON.stringify(target)}` };
    const euler = lookAtEuler(sub3(target, position));
    return euler === null ? { error: 'target coincides with position (zero-length aim)' } : { rotation: euler };
  }
  if (rotation === undefined) return { rotation: [0, 0, 0] };
  return isVec3(rotation) ? { rotation } : { error: `rotation must be 3 finite numbers [rx, ry, rz], got ${JSON.stringify(rotation)}` };
}
