/**
 * Lights, environment and camera of the path-traced scene (RV1 §5b). Light entities on visible layers become native lights (sun:
 * irradiance W/m², others: radiant power W); a document without any keeps the site sun (or the fixed render key light) at 3 W/m², the
 * default of `add_light`. The environment follows `set_environment`; absent, a site context gives its Preetham sky, else the uniform default.
 * @pure
 */

import type { CadDocument, Entity, Vec3 } from '../../../model/types';
import type { PathTraceCamera, PathTraceEnvironment, PathTraceLight } from '../../../model/pathTrace';
import { aimDirection } from '../../../lib/lookAt';
import { applyEulerXYZ } from '../../../lib/eulerRotation';
import { normalize3, sub3 } from '../../../lib/vec3';
import { fromMm } from '../../../model/units';
import { siteLightOf } from '../siteLight';
import { linearRgb, type MaterialBank } from './sceneMaterials';

/** Irradiance of the default sun (W/m²): `add_light`'s default, a white Lambert plane facing it shows radiance 3/π. */
export const DEFAULT_SUN_IRRADIANCE = 3;
/** Angular radius of the default sun (the real sun, 0.2666 deg). */
const SUN_ANGULAR_RADIUS = 0.004653;
/** Key light of the reference raster without a site context (`camera.ts` LIGHT_DIR). */
const RENDER_KEY_LIGHT: Vec3 = normalize3([0.6, -0.8, 1.0]);

const ORIGIN: Vec3 = [0, 0, 0];

type LightEntity = Extract<Entity, { readonly kind: 'light' }>;
type CameraEntity = Extract<Entity, { readonly kind: 'camera' }>;

export interface SceneLighting {
  readonly lights: PathTraceLight[];
  /** How the summary names the lighting. */
  readonly note: string;
}

function nativeLight(light: LightEntity): PathTraceLight {
  const color = linearRgb(light.lightColor);
  const power: [number, number, number] = [color[0] * light.intensity, color[1] * light.intensity, color[2] * light.intensity];
  const aim = aimDirection(light.rotation);
  const castShadows = light.castShadows;
  switch (light.lightType) {
    case 'sun':
      return { type: 'sun', direction: [-aim[0], -aim[1], -aim[2]], irradiance: power, angularRadius: light.radius, castShadows };
    case 'point':
      return { type: 'point', position: light.position, power, radius: light.radius, castShadows };
    case 'spot':
      return {
        type: 'spot',
        position: light.position,
        direction: aim,
        power,
        radius: light.radius,
        coneAngle: light.coneAngle ?? Math.PI / 4,
        blend: light.blend ?? 0.15,
        castShadows,
      };
    case 'area':
      return {
        type: 'area',
        position: light.position,
        uAxis: applyEulerXYZ([light.width ?? 1, 0, 0], ORIGIN, light.rotation),
        vAxis: applyEulerXYZ([0, light.height ?? 1, 0], ORIGIN, light.rotation),
        normal: aim,
        power,
        castShadows,
      };
  }
}

/** The sun direction the site context (or the reference key light) gives; null when the site sun is below the horizon. */
export function defaultSunDirection(doc: CadDocument): Vec3 | null {
  const site = siteLightOf(doc);
  return site === null ? RENDER_KEY_LIGHT : site.light.direction;
}

export function sceneLighting(doc: CadDocument): SceneLighting {
  const lights: PathTraceLight[] = [];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity?.kind !== 'light' || doc.layers[entity.layerId]?.visible === false) continue;
    lights.push(nativeLight(entity));
  }
  if (lights.length > 0) return { lights, note: `${lights.length} light entit${lights.length === 1 ? 'y' : 'ies'}` };
  const sun = defaultSunDirection(doc);
  if (sun === null) return { lights, note: 'no light entity; the site sun is below the horizon (sky light only)' };
  const irradiance: [number, number, number] = [DEFAULT_SUN_IRRADIANCE, DEFAULT_SUN_IRRADIANCE, DEFAULT_SUN_IRRADIANCE];
  lights.push({ type: 'sun', direction: sun, irradiance, angularRadius: SUN_ANGULAR_RADIUS, castShadows: true });
  const source = siteLightOf(doc) === null ? 'the default key light direction' : 'the site sun';
  return { lights, note: `no light entity: one sun of ${DEFAULT_SUN_IRRADIANCE} W/m2 from ${source}` };
}

export type EnvironmentOutcome = { readonly environment: PathTraceEnvironment; readonly note: string } | { readonly missing: string };

export function sceneEnvironment(doc: CadDocument, bank: MaterialBank): EnvironmentOutcome {
  const environment = doc.appearance?.environment;
  const sunDirection = defaultSunDirection(doc) ?? siteLightOf(doc)?.light.sky?.sunDirection ?? RENDER_KEY_LIGHT;
  if (environment === undefined) {
    if (doc.siteContext === undefined) return { environment: { type: 'default' }, note: 'uniform default sky (radiance 0.3)' };
    return { environment: { type: 'sky', turbidity: 2, intensity: 1, sunDirection }, note: 'Preetham sky of the site sun (turbidity 2)' };
  }
  switch (environment.source) {
    case 'sky':
      return {
        environment: { type: 'sky', turbidity: environment.turbidity, intensity: environment.intensity, sunDirection },
        note: `Preetham sky (turbidity ${environment.turbidity}, intensity ${environment.intensity})`,
      };
    case 'color':
      return {
        environment: { type: 'color', color: linearRgb(environment.color), intensity: environment.intensity },
        note: `uniform ${environment.color} environment (intensity ${environment.intensity})`,
      };
    case 'hdr': {
      const record = doc.appearance?.textures[environment.texture];
      if (record === undefined || record.format !== 'hdr') return { missing: environment.texture };
      const texture = bank.addTexture(record, 'linear');
      return {
        environment: { type: 'hdr', texture, rotation: environment.rotation, intensity: environment.intensity },
        note: `HDR environment ${record.name} (intensity ${environment.intensity})`,
      };
    }
  }
}

/** Depth of field of a camera entity: lens radius = focal length / (2 f-number), in document units; pinhole without an f-number. */
export function cameraLens(doc: CadDocument, camera: CameraEntity): Pick<PathTraceCamera, 'apertureRadius' | 'focusDistance'> {
  const apertureRadius = camera.fStop === undefined ? 0 : fromMm(doc, camera.focalLength / (2 * camera.fStop));
  return { apertureRadius, focusDistance: camera.focusDistance };
}

/** A look-at camera as the native camera (forward / up made orthonormal by the renderer). */
export function nativeCamera(
  position: Vec3,
  target: Vec3,
  up: Vec3,
  projection: PathTraceCamera['projection'],
  fovY: number,
  orthoHeight: number,
  lens: Pick<PathTraceCamera, 'apertureRadius' | 'focusDistance'>,
): PathTraceCamera {
  return { position, forward: normalize3(sub3(target, position)), up: normalize3(up), projection, fovY, orthoHeight, ...lens };
}

/** Camera entity of `id` (for the lens), or undefined. */
export function cameraEntityOf(doc: CadDocument, id: string | undefined): CameraEntity | undefined {
  const entity = id === undefined ? undefined : doc.entities[id];
  return entity?.kind === 'camera' ? entity : undefined;
}
