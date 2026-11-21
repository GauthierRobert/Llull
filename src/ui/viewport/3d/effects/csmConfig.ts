// Pure configuration of the cascaded shadow maps (High tier): cascade count and map size are fixed (bounded GPU memory), the far
// distance and light margin follow the scene extent so a mm part and a 100 m site split the same way.

import type { Vec3 } from '@core/model/types';
import type { KeyLightRig } from '../keyLightRig';

/** Cascades of the High tier. Three maps of `CSM_MAP_SIZE`^2 depth texels (48 MiB at 32 bit): the budget never grows with the scene. */
export const CSM_CASCADES = 3;
const CSM_MAP_SIZE = 2048;
/** Normal offset in texels of a cascade (the nearest cascade has the finest texel, so its offset is the smallest). */
const NORMAL_BIAS_TEXELS = 1.5;
const SHADOW_BIAS = -0.0004;

export interface CsmConfig {
  readonly cascades: number;
  readonly shadowMapSize: number;
  /** Shadowed distance from the camera: beyond it surfaces are lit (the scene's own extent, never the 1e8 camera far). */
  readonly maxFar: number;
  /** Unit direction the light travels (from the key light towards its target). */
  readonly lightDirection: Vec3;
  readonly lightNear: number;
  readonly lightFar: number;
  /** Distance the cascade light sits behind the farthest point of its slice: casters outside the view still shadow into it. */
  readonly lightMargin: number;
  readonly shadowBias: number;
}

/** @invariant cascades and map size are constants; every distance is proportional to the rig's half extent */
export function csmConfigFor(rig: KeyLightRig): CsmConfig {
  const direction: Vec3 = [rig.target[0] - rig.position[0], rig.target[1] - rig.position[1], rig.target[2] - rig.position[2]];
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const maxFar = rig.halfExtent * 2;
  return {
    cascades: CSM_CASCADES,
    shadowMapSize: CSM_MAP_SIZE,
    maxFar,
    lightDirection: [direction[0] / length, direction[1] / length, direction[2] / length],
    lightNear: maxFar * 1e-3,
    lightFar: maxFar * 4,
    lightMargin: maxFar,
    shadowBias: SHADOW_BIAS,
  };
}

/** Normal bias of a cascade whose ortho frustum is `extent` wide: a fixed number of its texels. */
export function cascadeNormalBias(extent: number, shadowMapSize: number): number {
  return (extent / shadowMapSize) * NORMAL_BIAS_TEXELS;
}

/** Stable identity of a config: the controller is rebuilt only when this changes (not on every scene bounds object). */
export function csmConfigKey(config: CsmConfig): string {
  return [config.maxFar, ...config.lightDirection].map((value) => value.toPrecision(6)).join('|');
}
