import type { CameraEntity, Vec3 } from '../../model/types';
import { cameraVerticalFov } from '../../model/sceneKinds';
import type { CommandResult } from '../types';
import { defineCommand, layerIdField, looseVec3, nameField, z } from '../schema';
import { nextId } from '../../lib/id';
import { ORIGIN, distance3 } from '../../lib/vec3';
import { toDegrees } from '../../lib/angle';
import { commitEntity } from '../entity/commitEntity';
import { existingLayerOrDefault } from '../solids/shared';
import { resolveAim, sceneRejection } from './shared';
import { cameraFieldsProblem } from './validate';

const DEFAULT_FOCAL_LENGTH = 50;
const DEFAULT_SENSOR: readonly [number, number] = [36, 24];
const FALLBACK_FOCUS_DISTANCE = 10;
const CAMERA_COLOR = '#9aa4b2';

/**
 * @affects creates 1 camera entity (no geometry: no volume, no mesh, never exported as a solid)
 * @invariant local -Z is the view axis and local +Y the up; a target is converted to a rotation with a level horizon (world +Z up)
 * @invariant focalLength, sensorWidth, sensorHeight, focusDistance, fStop (when given) > 0
 * @failure non-finite or zero-length aim, a non-positive optical field -> SCENE_CAMERA_INVALID, document unchanged
 */
export const addCamera = defineCommand({
  name: 'add_camera',
  description:
    'Add a physical camera to the scene (a scene object: no geometry, not part of the scene bounds or any export). ' +
    'It looks along its local -Z with local +Y up. Aim it with `target` (a world point, level horizon: world +Z stays up) OR `rotation` (Euler radians); with neither it looks straight down. ' +
    'Optics follow a real camera: focalLength (mm, default 50) on a sensor of sensorWidth x sensorHeight mm (default 36 x 24); the vertical field of view is 2*atan(sensorHeight / (2*focalLength)) (50 mm on 24 mm = 27 degrees). ' +
    'focusDistance (document units) defaults to the distance to target (10 without a target); fStop is the aperture f-number for depth of field (omit it for a pinhole: everything in focus). ' +
    'Use the camera with render_view `camera: <id>` (perspective view from it; the vertical field of view above, the image aspect from width / height). ' +
    'Errors: SCENE_CAMERA_INVALID (non-finite position / target, target equal to position, a non-positive focalLength / sensor / focusDistance / fStop).',
  params: z.object({
    position: looseVec3('World position [x, y, z] of the camera (the eye) in document units. Default [0, 0, 0].').optional(),
    target: looseVec3('World point [x, y, z] the camera looks at (must differ from position). Overrides rotation.').optional(),
    rotation: looseVec3(
      'Euler XYZ angles in radians [rx, ry, rz]; the camera looks along its local -Z. Ignored when target is given. Default [0, 0, 0] = straight down.',
    ).optional(),
    focalLength: z.number().describe('Focal length in mm, > 0. Default 50.').optional(),
    sensorWidth: z.number().describe('Sensor width in mm, > 0. Default 36.').optional(),
    sensorHeight: z.number().describe('Sensor height in mm, > 0. Default 24.').optional(),
    focusDistance: z
      .number()
      .describe('Distance to the plane in perfect focus, document units, > 0. Default: distance to target (10 without a target).')
      .optional(),
    fStop: z
      .number()
      .describe('Aperture f-number, > 0 (smaller = shallower depth of field). Omit for a pinhole (no depth of field).')
      .optional(),
    name: nameField(),
    layerId: layerIdField(),
  }),
  run: (doc, params): CommandResult => {
    const { position = ORIGIN, name } = params;
    const refuse = (message: string): CommandResult => sceneRejection(doc, 'add_camera', 'SCENE_CAMERA_INVALID', message, [], ['params']);
    const aim = resolveAim(position, params.target, params.rotation);
    if (aim.error !== undefined) return refuse(aim.error);
    const fields = {
      focalLength: params.focalLength ?? DEFAULT_FOCAL_LENGTH,
      sensorWidth: params.sensorWidth ?? DEFAULT_SENSOR[0],
      sensorHeight: params.sensorHeight ?? DEFAULT_SENSOR[1],
      focusDistance:
        params.focusDistance ?? (params.target === undefined ? FALLBACK_FOCUS_DISTANCE : distance3(params.target as Vec3, position)),
      ...(params.fStop === undefined ? {} : { fStop: params.fStop }),
    };
    const problem = cameraFieldsProblem(fields);
    if (problem !== null) return refuse(problem);
    const id = nextId('camera');
    const entity: CameraEntity = {
      id,
      kind: 'camera',
      ...fields,
      position,
      rotation: aim.rotation,
      layerId: existingLayerOrDefault(doc, params.layerId),
      color: CAMERA_COLOR,
      ...(name !== undefined && name !== '' ? { name } : {}),
    };
    const fov = +toDegrees(cameraVerticalFov(entity)).toFixed(2);
    return commitEntity(
      doc,
      entity,
      `Added camera ${id} at [${position.join(', ')}]: ${fields.focalLength} mm on ${fields.sensorWidth}x${fields.sensorHeight} mm (vertical fov ${fov} deg), focus ${+fields.focusDistance.toFixed(4)}${entity.fStop === undefined ? ', pinhole' : `, f/${entity.fStop}`}.`,
    );
  },
});
