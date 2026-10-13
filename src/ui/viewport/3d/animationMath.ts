import * as THREE from 'three';
import type { Animation, Vec3 } from '@core/model/types';

/** Frame scalar at `phase` s: spin = speed·phase, oscillate = amplitude·sin(2π·frequency·phase). Radians for rotation, world units for position. */
export function evaluateAnimationScalar(anim: Pick<Animation, 'mode' | 'speed' | 'amplitude' | 'frequency'>, phase: number): number {
  if (anim.mode === 'spin') return anim.speed * phase;
  return anim.amplitude * Math.sin(2 * Math.PI * anim.frequency * phase);
}

function rotateAboutPivotInPlace(point: THREE.Vector3, rotation: THREE.Quaternion, pivot: THREE.Vector3): THREE.Vector3 {
  return point.sub(pivot).applyQuaternion(rotation).add(pivot);
}

export interface AnimatedPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Reused temporaries: a per-frame caller allocates nothing. */
interface PoseScratch {
  readonly euler: THREE.Euler;
  readonly step: THREE.Quaternion;
  readonly offset: THREE.Vector3;
}

export function createPoseScratch(): PoseScratch {
  return { euler: new THREE.Euler(), step: new THREE.Quaternion(), offset: new THREE.Vector3() };
}

export interface AnimationContribution {
  /** 'rotation' also rotates the position about `pivot`. */
  channel: 'rotation' | 'position';
  axis: THREE.Vector3;
  scalar: number;
  pivot: THREE.Vector3;
}

/**
 * Base pose (position + XYZ euler) after ordered contributions: rotation premultiplies (later layers on top) and
 * rotates the position about its pivot; position adds axis·scalar. @invariant mutates only `pose` and `scratch`
 */
export function composeAnimatedPoseInto(
  pose: AnimatedPose,
  basePosition: Vec3,
  baseRotationEulerXYZ: Vec3,
  contributions: ReadonlyArray<AnimationContribution>,
  scratch: PoseScratch,
): void {
  pose.position.set(basePosition[0], basePosition[1], basePosition[2]);
  scratch.euler.set(baseRotationEulerXYZ[0], baseRotationEulerXYZ[1], baseRotationEulerXYZ[2], 'XYZ');
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
