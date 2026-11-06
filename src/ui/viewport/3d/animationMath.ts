import type { Object3D } from 'three';
import type { AnimatedPose } from '@core/geometry/animationPose';

/** Writes a core animated pose into a three.js object (the only three.js step of clip playback; the math is `@core/geometry/animationPose`). */
export function applyAnimatedPose(object: Pick<Object3D, 'position' | 'quaternion'>, pose: AnimatedPose): void {
  object.position.set(pose.position[0], pose.position[1], pose.position[2]);
  object.quaternion.set(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]);
}
