/** Declarative movement clips: the document declares motion, the viewport evaluates it per frame (no physics). */

import type { Vec3 } from './vectors';

export type AnimationChannel = 'rotation' | 'position';

/** 'spin' = constant velocity; 'oscillate' = sinusoidal back-and-forth. */
export type AnimationMode = 'spin' | 'oscillate';

export interface Animation {
  readonly id: string;
  /** Entity or group id, per `targetKind`. */
  targetId: string;
  targetKind: 'entity' | 'group';
  channel: AnimationChannel;
  /** Rotation axle or translation direction; the player normalizes it. */
  axis: Vec3;
  mode: AnimationMode;
  /** spin only: rad/s (rotation) or units/s (position). */
  speed: number;
  /** oscillate only: radians (rotation) or units (position). */
  amplitude: number;
  /** oscillate only: Hz. */
  frequency: number;
  /** rotation only: world-space pivot; defaults to the target's position. */
  pivot?: Vec3;
  /** 'auto' runs under global Play; 'click' toggles on click. */
  trigger: 'auto' | 'click';
}
