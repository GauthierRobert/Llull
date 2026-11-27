// Pure: how `doc.appearance.environment` (RV-M2 `set_environment`) shows in the viewport. Absent = the palette background and the
// built-in procedural environment, exactly as before.

import type { SceneEnvironment } from '@core/model/appearance';

export interface EnvironmentLook {
  /** Viewport background colour. */
  readonly background: string;
  /** Flat ambient tint added to the scene (colour environment only). */
  readonly ambient: { readonly color: string; readonly intensity: number } | null;
}

/** Ambient strength of a colour environment per unit of its `intensity`. */
const AMBIENT_PER_INTENSITY = 0.3;

export function environmentLook(environment: SceneEnvironment | undefined, paletteBackground: string): EnvironmentLook {
  if (environment?.source === 'color') {
    return {
      background: environment.color,
      ambient: { color: environment.color, intensity: environment.intensity * AMBIENT_PER_INTENSITY },
    };
  }
  return { background: paletteBackground, ambient: null };
}

/** Sky environment: turbidity for the Preetham model (1.7 clear .. 10 hazy); undefined when the environment is not a sky. */
export function skyTurbidity(environment: SceneEnvironment | undefined): number | undefined {
  return environment?.source === 'sky' ? environment.turbidity : undefined;
}

/**
 * Euler (order ZXY) that turns an equirectangular map, whose up is +Y, to the document's +Z up and spins it by `rotation` radians
 * about +Z: R = Rz(rotation) * Rx(pi / 2).
 */
export function hdrOrientation(rotation: number): readonly [number, number, number] {
  return [Math.PI / 2, 0, rotation];
}
