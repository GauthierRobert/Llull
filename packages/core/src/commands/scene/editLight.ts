import type { LightEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { colorField, defineCommand, looseVec3, nameField, z } from '../schema';
import { isVec3 } from '../../lib/vec3';
import { changed } from '../noop';
import { replaceEntity } from '../entity/entityOps';
import { entityOfKind } from '../entity/entityOfKind';
import { resolveAim, sceneRejection } from './shared';
import { lightFieldsProblem } from './validate';

/**
 * @affects modifies 1 light entity (only the given fields; lightType is fixed)
 * @invariant the result satisfies every add_light invariant (checked on the merged fields)
 * @failure missing id -> SCENE_OBJECT_NOT_FOUND; not a light, no field given, or an invalid merged light -> SCENE_LIGHT_INVALID, document unchanged
 */
export const editLight = defineCommand({
  name: 'edit_light',
  description:
    'Edit an existing light (created by add_light): only the given fields change; lightType cannot change (add a new light instead). ' +
    'Aim again with `target` (world point) or `rotation`; `position` alone keeps the current rotation. coneAngle / blend apply to spots only, width / height to areas only. ' +
    'Units as in add_light (sun W/m2, others W). Errors: SCENE_OBJECT_NOT_FOUND (unknown id), SCENE_LIGHT_INVALID (not a light, nothing to change, or an out-of-range value).',
  params: z.object({
    id: z.string().describe('Id of the light to edit.'),
    position: looseVec3('New world position [x, y, z].').optional(),
    target: looseVec3('World point to aim at (must differ from the position the light ends up at). Overrides rotation.').optional(),
    rotation: looseVec3('New Euler XYZ angles in radians; the light emits along its local -Z. Ignored when target is given.').optional(),
    intensity: z.number().describe('New intensity >= 0 (sun W/m2, others W).').optional(),
    color: colorField('the current color'),
    radius: z.number().describe('New emitter radius >= 0 (sun: angular radius in radians).').optional(),
    coneAngle: z.number().describe('Spot only: new full cone angle in radians in (0, pi/2].').optional(),
    blend: z.number().describe('Spot only: new soft edge fraction in [0, 1].').optional(),
    width: z.number().describe('Area only: new width > 0.').optional(),
    height: z.number().describe('Area only: new height > 0.').optional(),
    castShadows: z.boolean().describe('Whether the light casts shadows.').optional(),
    name: nameField(),
  }),
  run: (doc, params): CommandResult => {
    const { id } = params;
    const found = entityOfKind(doc, id, ['light']);
    if (typeof found === 'string') {
      const code = doc.entities[id] === undefined ? 'SCENE_OBJECT_NOT_FOUND' : 'SCENE_LIGHT_INVALID';
      return sceneRejection(doc, 'edit_light', code, found, [id], ['id']);
    }
    const refuse = (message: string): CommandResult => sceneRejection(doc, 'edit_light', 'SCENE_LIGHT_INVALID', message, [id], ['params']);
    const { id: _id, ...edits } = params;
    if (Object.values(edits).every((value) => value === undefined)) return refuse('nothing to change: give at least one field');
    const position = params.position ?? found.position;
    let rotation = found.rotation;
    if (params.target !== undefined || params.rotation !== undefined || params.position !== undefined) {
      if (params.position !== undefined && !isVec3(params.position))
        return refuse(`position must be 3 finite numbers, got ${JSON.stringify(params.position)}`);
      const aim =
        params.target !== undefined || params.rotation !== undefined ? resolveAim(position, params.target, params.rotation) : { rotation };
      if (aim.error !== undefined) return refuse(aim.error);
      rotation = aim.rotation;
    }
    const merged: LightEntity = {
      ...found,
      position,
      rotation,
      ...(params.intensity === undefined ? {} : { intensity: params.intensity }),
      ...(params.color === undefined ? {} : { lightColor: params.color, color: params.color }),
      ...(params.radius === undefined ? {} : { radius: params.radius }),
      ...(params.coneAngle === undefined ? {} : { coneAngle: params.coneAngle }),
      ...(params.blend === undefined ? {} : { blend: params.blend }),
      ...(params.width === undefined ? {} : { width: params.width }),
      ...(params.height === undefined ? {} : { height: params.height }),
      ...(params.castShadows === undefined ? {} : { castShadows: params.castShadows }),
      ...(params.name === undefined ? {} : { name: params.name }),
    };
    const problem = lightFieldsProblem({ ...merged });
    if (problem !== null) return refuse(problem);
    const changedFields = Object.entries(edits)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    return changed(replaceEntity(doc, merged), `Edited ${found.lightType} light ${id}: ${changedFields.join(', ')}.`, [id]);
  },
});
