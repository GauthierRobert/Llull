import type { LightEntity } from '../../model/types';
import { LIGHT_TYPES, type LightType } from '../../model/sceneKinds';
import type { CommandResult } from '../types';
import { colorField, defineCommand, layerIdField, looseVec3, nameField, z } from '../schema';
import { nextId } from '../../lib/id';
import { ORIGIN } from '../../lib/vec3';
import { commitEntity } from '../entity/commitEntity';
import { existingLayerOrDefault } from '../solids/shared';
import { resolveAim, sceneRejection } from './shared';
import { lightFieldsProblem } from './validate';

const DEFAULT_COLOR = '#ffffff';
const DEFAULT_INTENSITY: Readonly<Record<LightType, number>> = { sun: 3, point: 1000, spot: 1000, area: 100 };
const SUN_ANGULAR_RADIUS = 0.00465;
const DEFAULT_CONE_ANGLE = Math.PI / 4;
const DEFAULT_BLEND = 0.15;

/**
 * @affects creates 1 light entity (no geometry: no volume, no mesh, never exported as a solid)
 * @invariant local -Z is the aim: `target` is converted to a rotation; sun position only places its glyph
 * @invariant intensity >= 0; spot 0 < coneAngle <= pi/2 and 0 <= blend <= 1; area width, height > 0; coneAngle / blend only on spots, width / height only on areas
 * @failure non-finite or zero-length aim, negative intensity, bad cone / blend / area size, bad color -> SCENE_LIGHT_INVALID, document unchanged
 */
export const addLight = defineCommand({
  name: 'add_light',
  description:
    'Add a light source to the scene (a scene object: it has no geometry and does not enter volumes, booleans, exports or the scene bounds). ' +
    'lightType: "sun" (parallel rays; position only places its glyph, the aim gives the direction), "point" (omnidirectional), ' +
    '"spot" (cone of coneAngle radians, soft edge blend) or "area" (width x height rectangle in the local XY plane emitting toward local -Z). ' +
    'Aim: give `target` (a world point the light shines toward) OR `rotation` (Euler radians; local -Z is the aim axis); with neither the light shines straight down (-Z). ' +
    'Units: sun intensity is irradiance in W/m2 (default 3), the others radiant power in W (defaults point 1000, spot 1000, area 100); ' +
    'color is the light color #rrggbb (default white); radius softens shadows (point/spot: emitter radius in document units; sun: angular radius in radians, default 0.00465 = the real sun disc; 0 = hard). ' +
    'Lights are drawn as glyphs by the viewport and are used by render_realistic (planned); render_view shading does not change. ' +
    'Errors: SCENE_LIGHT_INVALID (non-finite position / target, target equal to position, intensity < 0, spot coneAngle outside (0, pi/2] or blend outside [0, 1], area without width and height > 0, coneAngle / blend on a non-spot, width / height on a non-area).',
  params: z.object({
    lightType: z.enum(LIGHT_TYPES).describe('"sun", "point", "spot" or "area" (see the command description).'),
    position: looseVec3(
      'World position [x, y, z] of the light in document units. Default [0, 0, 0]. For a sun it only places the glyph.',
    ).optional(),
    target: looseVec3('World point [x, y, z] the light is aimed at (must differ from position). Overrides rotation.').optional(),
    rotation: looseVec3(
      'Euler XYZ angles in radians [rx, ry, rz]; the light emits along its local -Z. Ignored when target is given. Default [0, 0, 0] = straight down.',
    ).optional(),
    intensity: z
      .number()
      .describe('Intensity >= 0: sun W/m2, point / spot / area W. Defaults: sun 3, point 1000, spot 1000, area 100.')
      .optional(),
    color: colorField(DEFAULT_COLOR),
    radius: z
      .number()
      .describe('Emitter radius >= 0 for soft shadows (sun: angular radius in radians). Default 0 (sun 0.00465).')
      .optional(),
    coneAngle: z.number().describe('Spot only: full cone angle in radians in (0, pi/2]. Default pi/4.').optional(),
    blend: z.number().describe('Spot only: soft edge fraction of the cone in [0, 1]. Default 0.15.').optional(),
    width: z.number().describe('Area only (required): rectangle width along local X, document units, > 0.').optional(),
    height: z.number().describe('Area only (required): rectangle height along local Y, document units, > 0.').optional(),
    castShadows: z.boolean().describe('Whether the light casts shadows. Default true.').optional(),
    name: nameField(),
    layerId: layerIdField(),
  }),
  run: (doc, params): CommandResult => {
    const { lightType, position = ORIGIN, name } = params;
    const refuse = (message: string): CommandResult => sceneRejection(doc, 'add_light', 'SCENE_LIGHT_INVALID', message, [], ['params']);
    const aim = resolveAim(position, params.target, params.rotation);
    if (aim.error !== undefined) return refuse(aim.error);
    const lightColor = params.color ?? DEFAULT_COLOR;
    const fields = {
      lightType,
      intensity: params.intensity ?? DEFAULT_INTENSITY[lightType],
      lightColor,
      radius: params.radius ?? (lightType === 'sun' ? SUN_ANGULAR_RADIUS : 0),
      castShadows: params.castShadows ?? true,
      ...(lightType === 'spot' ? { coneAngle: params.coneAngle ?? DEFAULT_CONE_ANGLE, blend: params.blend ?? DEFAULT_BLEND } : {}),
      ...(params.coneAngle !== undefined && lightType !== 'spot' ? { coneAngle: params.coneAngle } : {}),
      ...(params.blend !== undefined && lightType !== 'spot' ? { blend: params.blend } : {}),
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.height !== undefined ? { height: params.height } : {}),
    };
    const problem = lightFieldsProblem(fields);
    if (problem !== null) return refuse(problem);
    const id = nextId('light');
    const entity: LightEntity = {
      id,
      kind: 'light',
      ...fields,
      position,
      rotation: aim.rotation,
      layerId: existingLayerOrDefault(doc, params.layerId),
      color: lightColor,
      ...(name !== undefined && name !== '' ? { name } : {}),
    };
    const size = entity.width === undefined ? '' : `, ${entity.width}x${entity.height}`;
    const cone = entity.coneAngle === undefined ? '' : `, cone ${+entity.coneAngle.toFixed(4)} rad`;
    return commitEntity(
      doc,
      entity,
      `Added ${lightType} light ${id} at [${position.join(', ')}], intensity ${entity.intensity} ${lightType === 'sun' ? 'W/m2' : 'W'}, color ${lightColor}${size}${cone}, shadows ${entity.castShadows ? 'on' : 'off'}.`,
    );
  },
});
