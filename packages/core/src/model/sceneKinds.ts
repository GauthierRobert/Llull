/**
 * Scene objects (RV1 RV-M2, closes G10 / G11): light and camera entities. They have no geometry (no volume, no area, no kernel leaf, no
 * mesh); they live in the entity bag so they get layers, names, tags, selection and the transform commands. `position` places them,
 * `rotation` (Euler XYZ) turns their local aim axis -Z (a camera also uses local +Y as up). A document without lights renders as before.
 */

export const SCENE_KINDS = ['light', 'camera'] as const;

export type SceneKind = (typeof SCENE_KINDS)[number];

const SCENE_KIND_SET: ReadonlySet<string> = new Set(SCENE_KINDS);

/** True for a light or camera entity: no geometry, so geometry commands, exports and checks skip it. */
export function isSceneObject<E extends { readonly kind: string }>(entity: E): entity is Extract<E, { readonly kind: SceneKind }> {
  return SCENE_KIND_SET.has(entity.kind);
}

export const LIGHT_TYPES = ['sun', 'point', 'spot', 'area'] as const;

export type LightType = (typeof LIGHT_TYPES)[number];

/**
 * Light fields. Intensity units: `sun` irradiance in W/m² (lux / 683), the others radiant power in W.
 * @invariant intensity >= 0 and finite; color `#rrggbb`; spot 0 < coneAngle <= pi/2, 0 <= blend <= 1; area width, height > 0; radius >= 0
 */
export interface LightFields {
  lightType: LightType;
  intensity: number;
  /** Light colour, hex `#rrggbb` (multiplies intensity). */
  lightColor: string;
  /** Emitter radius for soft shadows (point / spot), document units; sun: angular radius in radians. 0 = hard. */
  radius: number;
  /** Spot: full cone angle, radians. */
  coneAngle?: number;
  /** Spot: soft edge fraction of the cone, 0 (hard) .. 1. */
  blend?: number;
  /** Area: rectangle in the local XY plane, emitting toward local -Z, document units. */
  width?: number;
  height?: number;
  castShadows: boolean;
}

/**
 * Camera fields (physical camera: focal length on a sensor; vertical field of view = 2 atan(sensorHeight / (2 focalLength))).
 * @invariant focalLength, sensorWidth, sensorHeight > 0 (mm); focusDistance > 0 (document units); fStop > 0 or absent (pinhole, no depth of field)
 */
export interface CameraFields {
  focalLength: number;
  sensorWidth: number;
  sensorHeight: number;
  focusDistance: number;
  /** Aperture as an f-number; absent = pinhole (everything in focus). */
  fStop?: number;
}

/** Vertical field of view of a camera, radians. */
export function cameraVerticalFov(camera: Pick<CameraFields, 'focalLength' | 'sensorHeight'>): number {
  return 2 * Math.atan(camera.sensorHeight / (2 * camera.focalLength));
}
