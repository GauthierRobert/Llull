/**
 * @layer ui/viewport/3d
 *
 * Pure math helpers for the AnimationPlayer.
 * No React, no DOM — testable in isolation (rule W3).
 *
 * All THREE.js math classes are fine here (three is a ui-layer dependency).
 */

import * as THREE from 'three';
import type { Animation, Vec3 } from '@core/model/types';

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

/** Rotate `point` in place by `rotation` about `pivot` (translate to the pivot, rotate, translate back). */
function rotateAboutPivotInPlace(
  point: THREE.Vector3,
  rotation: THREE.Quaternion,
  pivot: THREE.Vector3,
): THREE.Vector3 {
  return point.sub(pivot).applyQuaternion(rotation).add(pivot);
}

/**
 * Rotate `point` by `angle` radians about `axis` around `pivot`.
 *
 * Returns a new THREE.Vector3; inputs are not mutated.
 *
 * @pure
 */
export function rotatePointAboutPivot(
  point: THREE.Vector3,
  axis: THREE.Vector3,
  angle: number,
  pivot: THREE.Vector3,
): THREE.Vector3 {
  const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  return rotateAboutPivotInPlace(point.clone(), rotation, pivot);
}

/** A quaternion expressed as [x, y, z, w]. */
type QuaternionTuple = [number, number, number, number];

/** Pose written by `composeAnimatedPoseInto`. */
export interface AnimatedPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Temporaries reused across `composeAnimatedPoseInto` calls so a per-frame caller allocates nothing. */
export interface PoseScratch {
  readonly euler: THREE.Euler;
  readonly step: THREE.Quaternion;
  readonly offset: THREE.Vector3;
}

export function createPoseScratch(): PoseScratch {
  return { euler: new THREE.Euler(), step: new THREE.Quaternion(), offset: new THREE.Vector3() };
}

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
 * Write into `pose` the final position and quaternion of a base entity pose (position + rotation as
 * euler XYZ) after an ordered list of animation contributions; allocation-free given `scratch`.
 *
 * Composition rules:
 * - Rotation: `q_new = contribution_q * q_accumulated` (premultiply so later
 *   contributions layer on top of earlier ones).
 * - Position from rotation: the accumulated position is also rotated about the
 *   pivot by the contribution angle each time.
 * - Position channel: offset = axis * scalar, added to accumulated position.
 *
 * @invariant mutates only `pose` and `scratch`
 */
export function composeAnimatedPoseInto(
  pose: AnimatedPose,
  basePosition: Vec3,
  baseRotationEulerXYZ: Vec3,
  contributions: ReadonlyArray<AnimationContribution>,
  scratch: PoseScratch,
): void {
  pose.position.set(basePosition[0], basePosition[1], basePosition[2]);
  scratch.euler.set(
    baseRotationEulerXYZ[0],
    baseRotationEulerXYZ[1],
    baseRotationEulerXYZ[2],
    'XYZ',
  );
  pose.quaternion.setFromEuler(scratch.euler);

  for (const contrib of contributions) {
    if (contrib.channel === 'rotation') {
      scratch.step.setFromAxisAngle(contrib.axis, contrib.scalar);
      pose.quaternion.premultiply(scratch.step);
      rotateAboutPivotInPlace(pose.position, scratch.step, contrib.pivot);
    } else {
      pose.position.add(scratch.offset.copy(contrib.axis).multiplyScalar(contrib.scalar));
    }
  }
}

/**
 * `composeAnimatedPoseInto` returning new tuples.
 *
 * @pure — no input mutation.
 */
export function composeAnimatedPose(
  basePosition: Vec3,
  baseRotationEulerXYZ: Vec3,
  contributions: ReadonlyArray<AnimationContribution>,
): { position: [number, number, number]; quaternion: QuaternionTuple } {
  const pose: AnimatedPose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  composeAnimatedPoseInto(
    pose,
    basePosition,
    baseRotationEulerXYZ,
    contributions,
    createPoseScratch(),
  );
  const { position, quaternion } = pose;
  return {
    position: [position.x, position.y, position.z],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
  };
}
