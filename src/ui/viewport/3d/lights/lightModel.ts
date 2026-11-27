// Pure: how a `light` entity maps to a three.js light, which authored lights cast shadows, how the built-in rig yields to them, and the
// shadow camera that covers the scene. No React; three.js only for the Euler / matrix algebra of the sun frustum.

import * as THREE from 'three';
import type { LightFields } from '@core/model/sceneKinds';
import type { Vec3 } from '@core/model/types';

/** Shadow-casting authored lights drawn at once (a point light costs six shadow passes): the first ones in document order win. */
const MAX_AUTHORED_SHADOW_LIGHTS = 3;

/** Sun irradiance (W/m^2) -> three.js directional intensity: 3 W/m^2 equals the built-in key light (1.8), the Blender-style "sun strength". */
const SUN_TO_THREE = 0.6;
/** Radiometric W -> candela of an isotropic emitter, 1 / (4 pi); spot lights use the same (Blender convention: a cone does not concentrate power). */
const WATT_TO_CANDELA = 1 / (4 * Math.PI);

export interface ThreeLight {
  readonly type: 'sun' | 'point' | 'spot' | 'area';
  readonly color: string;
  /** three.js units: lux-like (sun), candela (point / spot, per document unit squared), nits (area). */
  readonly intensity: number;
  /** Spot half-angle, radians. */
  readonly angle: number;
  readonly penumbra: number;
  readonly width: number;
  readonly height: number;
}

type LightSource = Pick<LightFields, 'lightType' | 'intensity' | 'lightColor' | 'coneAngle' | 'blend' | 'width' | 'height'>;

/**
 * Viewport approximation of the stored radiometric intensity (the path tracer of RV-M3 uses the physical value).
 * Point / spot decay with the inverse square of the distance in METRES, so the candela is divided by (metres per document unit)^2.
 */
export function threeLightOf(light: LightSource, metresPerUnit: number): ThreeLight {
  const unitSq = metresPerUnit * metresPerUnit;
  const width = light.width ?? 1;
  const height = light.height ?? 1;
  let intensity: number;
  switch (light.lightType) {
    case 'sun':
      intensity = light.intensity * SUN_TO_THREE;
      break;
    case 'area':
      // Lambertian emitter of power P over area A (m^2): radiance P / (pi A).
      intensity = light.intensity / (Math.PI * Math.max(width * height * unitSq, 1e-9));
      break;
    default:
      intensity = (light.intensity * WATT_TO_CANDELA) / unitSq;
  }
  return {
    type: light.lightType,
    color: light.lightColor,
    intensity,
    angle: (light.coneAngle ?? Math.PI / 4) / 2,
    penumbra: light.blend ?? 0,
    width,
    height,
  };
}

/** Ids of the authored lights that cast shadows: `castShadows`, at most `limit` (document order), none when the quality tier has no shadows. */
export function shadowCasterIds(
  lights: ReadonlyArray<{ readonly id: string; readonly castShadows: boolean; readonly lightType: string }>,
  shadowsEnabled: boolean,
  limit: number = MAX_AUTHORED_SHADOW_LIGHTS,
): ReadonlySet<string> {
  if (!shadowsEnabled) return new Set();
  // Area lights never cast shadows in three.js.
  return new Set(
    lights
      .filter((light) => light.castShadows && light.lightType !== 'area')
      .slice(0, limit)
      .map((light) => light.id),
  );
}

export interface KeyLightRule {
  /** Multiplier of the built-in key light (site sun / default key). */
  readonly keyScale: number;
  /** The built-in key light still casts its shadow. */
  readonly keyShadows: boolean;
}

/**
 * The built-in rig against authored lights (decision RV-M2):
 * - no light entity: the rig is untouched (identical to before RV-M2);
 * - a `sun` light replaces the built-in key light (it is switched off, with its shadow);
 * - other lights only: the key light stays as a dim fill (35 %) and keeps its shadow, so the authored lights read.
 * The hemisphere fill and the environment always stay (an unlit side is never pure black).
 */
export function keyLightRule(lights: ReadonlyArray<Pick<LightFields, 'lightType'>>): KeyLightRule {
  if (lights.length === 0) return { keyScale: 1, keyShadows: true };
  if (lights.some((light) => light.lightType === 'sun')) return { keyScale: 0, keyShadows: false };
  return { keyScale: 0.35, keyShadows: true };
}

export interface ShadowFrustum {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Orthographic shadow camera of a sun light (at `position`, aiming along local -Z turned by Euler XYZ `rotation`) that covers the sphere
 * (`center`, `radius`) of the scene. The window is centred on the sphere's projection, so a sun placed anywhere still shadows the scene.
 */
export function sunShadowFrustum(position: Vec3, rotation: Vec3, center: Vec3, radius: number): ShadowFrustum {
  const turn = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2], 'XYZ'));
  const local = new THREE.Vector3(center[0] - position[0], center[1] - position[1], center[2] - position[2]).applyMatrix4(turn.transpose());
  const margin = radius * 1.05;
  const ahead = -local.z;
  return {
    left: local.x - margin,
    right: local.x + margin,
    top: local.y + margin,
    bottom: local.y - margin,
    near: Math.max(ahead - margin, margin * 1e-3),
    far: Math.max(ahead + margin, margin * 2e-3),
  };
}

/** Depth range of a point / spot shadow camera at `distance` from the scene's centre. */
export function perspectiveShadowRange(distance: number, radius: number): { readonly near: number; readonly far: number } {
  return { near: Math.max((distance - radius * 1.05) * 0.9, radius * 1e-3), far: distance + radius * 1.05 };
}
