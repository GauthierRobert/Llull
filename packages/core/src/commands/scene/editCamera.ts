import type { CameraEntity } from '../../model/types';
import { cameraVerticalFov } from '../../model/sceneKinds';
import type { CommandResult } from '../types';
import { defineCommand, looseVec3, nameField, z } from '../schema';
import { distance3, isVec3 } from '../../lib/vec3';
import { toDegrees } from '../../lib/angle';
import { changed } from '../noop';
import { replaceEntity } from '../entity/entityOps';
import { entityOfKind } from '../entity/entityOfKind';
import { resolveAim, sceneRejection } from './shared';
import { cameraFieldsProblem } from './validate';

/**
 * @affects modifies 1 camera entity (only the given fields)
 * @invariant the result satisfies every add_camera invariant (checked on the merged fields)
 * @failure missing id -> SCENE_OBJECT_NOT_FOUND; not a camera, no field given, or an invalid merged camera -> SCENE_CAMERA_INVALID, document unchanged
 */
export const editCamera = defineCommand({
  name: 'edit_camera',
  description:
    'Edit a camera entity (created by add_camera; NOT the viewport orbit camera, which is set_camera): only the given fields change. Re-aim with `target` (world point, level horizon) or `rotation`; `position` alone keeps the current rotation. A new `target` also resets focusDistance to the distance to it (unless focusDistance is given). ' +
    'Optics as in add_camera (focalLength and sensor in mm, focusDistance in document units, fStop f-number; `pinhole: true` removes the aperture). ' +
    'Errors: SCENE_OBJECT_NOT_FOUND (unknown id), SCENE_CAMERA_INVALID (not a camera, nothing to change, or a non-finite / non-positive value).',
  params: z.object({
    id: z.string().describe('Id of the camera to edit.'),
    position: looseVec3('New world position [x, y, z] of the eye.').optional(),
    target: looseVec3(
      'World point to look at (must differ from the position the camera ends up at). Overrides rotation; focusDistance is re-derived as the distance to it unless given.',
    ).optional(),
    rotation: looseVec3('New Euler XYZ angles in radians; the camera looks along its local -Z. Ignored when target is given.').optional(),
    focalLength: z.number().describe('New focal length in mm, > 0.').optional(),
    sensorWidth: z.number().describe('New sensor width in mm, > 0.').optional(),
    sensorHeight: z.number().describe('New sensor height in mm, > 0.').optional(),
    focusDistance: z.number().describe('New focus distance in document units, > 0.').optional(),
    fStop: z.number().describe('New aperture f-number, > 0.').optional(),
    pinhole: z.boolean().describe('true removes the aperture (pinhole: no depth of field). Excludes fStop.').optional(),
    name: nameField(),
  }),
  run: (doc, params): CommandResult => {
    const { id } = params;
    const found = entityOfKind(doc, id, ['camera']);
    if (typeof found === 'string') {
      const code = doc.entities[id] === undefined ? 'SCENE_OBJECT_NOT_FOUND' : 'SCENE_CAMERA_INVALID';
      return sceneRejection(doc, 'edit_camera', code, found, [id], ['id']);
    }
    const refuse = (message: string): CommandResult =>
      sceneRejection(doc, 'edit_camera', 'SCENE_CAMERA_INVALID', message, [id], ['params']);
    const { id: _id, ...edits } = params;
    if (Object.values(edits).every((value) => value === undefined)) return refuse('nothing to change: give at least one field');
    if (params.pinhole === true && params.fStop !== undefined) return refuse('give fStop or pinhole: true, not both');
    const position = params.position ?? found.position;
    if (params.position !== undefined && !isVec3(params.position))
      return refuse(`position must be 3 finite numbers, got ${JSON.stringify(params.position)}`);
    const aim =
      params.target !== undefined || params.rotation !== undefined
        ? resolveAim(position, params.target, params.rotation)
        : { rotation: found.rotation };
    if (aim.error !== undefined) return refuse(aim.error);
    const { fStop: previousFStop, ...withoutFStop } = found;
    const fStop = params.pinhole === true ? undefined : (params.fStop ?? previousFStop);
    const focusDistance =
      params.focusDistance ?? (params.target === undefined || !isVec3(params.target) ? undefined : distance3(params.target, position));
    const merged: CameraEntity = {
      ...withoutFStop,
      position,
      rotation: aim.rotation,
      ...(fStop === undefined ? {} : { fStop }),
      ...(params.focalLength === undefined ? {} : { focalLength: params.focalLength }),
      ...(params.sensorWidth === undefined ? {} : { sensorWidth: params.sensorWidth }),
      ...(params.sensorHeight === undefined ? {} : { sensorHeight: params.sensorHeight }),
      ...(focusDistance === undefined ? {} : { focusDistance }),
      ...(params.name === undefined ? {} : { name: params.name }),
    };
    const problem = cameraFieldsProblem({ ...merged });
    if (problem !== null) return refuse(problem);
    const changedFields = Object.entries(edits)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    const fov = +toDegrees(cameraVerticalFov(merged)).toFixed(2);
    return changed(replaceEntity(doc, merged), `Edited camera ${id}: ${changedFields.join(', ')}; vertical fov ${fov} deg.`, [id]);
  },
});
