/**
 * @layer ui/viewport/3d
 *
 * Pure math helpers for the AnimationPlayer.
 * No React, no DOM — testable in isolation (rule W3).
 *
 * All THREE.js math classes are fine here (three is a ui-layer dependency).
 */

import * as THREE from 'three';
import type { Animation } from '@core/model/types';

// ---------------------------------------------------------------------------
// Scalar evaluation
// ---------------------------------------------------------------------------

/**
 * Given an animation definition and the current accumulated phase (seconds),
 * return the scalar value for this frame.
 *
 * - `spin`      → `speed * phase`  (linear ramp)
 * - `oscillate` → `amplitude * sin(2π * frequency * phase)` (sinusoidal)
 *
 * The returned value is an angle (radians) for `rotation` animations and a
 * distance (world units) for `position` animations — callers interpret the
 * channel themselves.
 *
 * @pure
 */
export function evaluateAnimationScalar(
  anim: Pick<Animation, 'mode' | 'speed' | 'amplitude' | 'frequency'>,
  phase: number,
): number {
  if (anim.mode === 'spin') {
    return anim.speed * phase;
  }
  // oscillate
  return anim.amplitude * Math.sin(2 * Math.PI * anim.frequency * phase);
}

// ---------------------------------------------------------------------------
// Pivot rotation
// ---------------------------------------------------------------------------

/**
 * Rotate `point` by `angle` radians about `axis` around `pivot`.
 *
 * Returns a new THREE.Vector3; inputs are not mutated.
 *
 * Algorithm: translate so pivot is origin → apply axis-angle rotation →
 * translate back.
 *
 * @pure
 */
export function rotatePointAboutPivot(
  point: THREE.Vector3,
  axis: THREE.Vector3,
  angle: number,
  pivot: THREE.Vector3,
): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  const result = point.clone().sub(pivot);
  result.applyQuaternion(q);
  result.add(pivot);
  return result;
}

// ---------------------------------------------------------------------------
// Composed pose
// ---------------------------------------------------------------------------

/** A position expressed as a plain triple (avoids THREE import at call sites). */
export type PositionTuple = [number, number, number];

/** A quaternion expressed as [x, y, z, w]. */
export type QuaternionTuple = [number, number, number, number];

/**
 * One animation contribution that may be composed onto an existing pose.
 */
export interface AnimationContribution {
  /** 'rotation' applies an axis-angle on top of the current quaternion and
   *  also rotates the position around `pivot`. */
  channel: 'rotation' | 'position';
  /** Normalised axis. */
  axis: THREE.Vector3;
  /** Scalar returned by `evaluateAnimationScalar`. */
  scalar: number;
  /** Pivot point for rotation contributions. */
  pivot: THREE.Vector3;
}

/**
 * Given a base entity pose (position + rotation as euler XYZ) and an ordered
 * list of animation contributions, return the final position and quaternion
 * tuples after all contributions are applied.
 *
 * Composition rules:
 * - Rotation: `q_new = contribution_q * q_accumulated` (premultiply so later
 *   contributions layer on top of earlier ones).
 * - Position from rotation: the accumulated position is also rotated about the
 *   pivot by the contribution angle each time.
 * - Position channel: offset = axis * scalar, added to accumulated position.
 *
 * @pure — returns new tuples; no input mutation.
 */
export function composeAnimatedPose(
  basePosition: PositionTuple,
  baseRotationEulerXYZ: PositionTuple,
  contributions: AnimationContribution[],
): { position: PositionTuple; quaternion: QuaternionTuple } {
  const pos = new THREE.Vector3(...basePosition);
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      baseRotationEulerXYZ[0],
      baseRotationEulerXYZ[1],
      baseRotationEulerXYZ[2],
      'XYZ',
    ),
  );

  for (const contrib of contributions) {
    if (contrib.channel === 'rotation') {
      const dq = new THREE.Quaternion().setFromAxisAngle(contrib.axis, contrib.scalar);
      quat.premultiply(dq);

      // Rotate position around pivot too.
      const rotated = rotatePointAboutPivot(pos, contrib.axis, contrib.scalar, contrib.pivot);
      pos.copy(rotated);
    } else {
      // position channel: translate along axis
      const offset = contrib.axis.clone().multiplyScalar(contrib.scalar);
      pos.add(offset);
    }
  }

  return {
    position: [pos.x, pos.y, pos.z],
    quaternion: [quat.x, quat.y, quat.z, quat.w],
  };
}
