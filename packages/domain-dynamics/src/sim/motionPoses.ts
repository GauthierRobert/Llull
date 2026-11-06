/**
/**
 * Body poses along a simulated run for the motion-clearance check (PHY-21 TR-FPR-10): motion detection, travel bounds and the rigid
 * transform that carries one start-pose mesh into another's frame (interpolation: `poseAtFraction` in core geometry/bodyPose).
 * @invariant pure
 */

import type { Vec3 } from '@core/model/vectors';
import { applyMat3, mulMat3, type Mat3 } from '@lib/axisRotation';
import type { RigidTransform } from '@core/geometry/meshBvh';
import { type BodyPoseAt, type PoseTrack, matFromQuaternion } from '@core/geometry/bodyPose';
import type { Quaternion } from '@core/model/vectors';

/** Pose of a part that never moves: the identity motion. */
export const STATIC_POSE: BodyPoseAt = { start: [0, 0, 0], position: [0, 0, 0], orientation: [1, 0, 0, 0] };

const TINY = 1e-9;

/** Whether the body leaves its start pose at any sample. */
export function isMoving(track: PoseTrack): boolean {
  const start = track.position[0];
  if (start === undefined) return false;
  const moved = track.position.some((p) => Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]) > TINY);
  return moved || track.orientation.some((q) => Math.abs(q[0]) < 1 - TINY);
}

/** Upper bound on how far any point at distance `radius` from the centre of mass travels between samples `index` and `index + 1`. */
export function travelBound(track: PoseTrack, index: number, radius: number): number {
  const [p, q] = [track.position[index], track.position[index + 1]];
  const [a, b] = [track.orientation[index], track.orientation[index + 1]];
  if (p === undefined || q === undefined || a === undefined || b === undefined) return 0;
  const angle = 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
  return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) + angle * radius;
}

const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Motion of mesh B (its start-pose points) into the start-pose frame of mesh A, with A and B carried by poses `a` and `b`. */
export function relativeTransform(a: BodyPoseAt, b: BodyPoseAt): RigidTransform {
  const rotationA = matFromQuaternion(a.orientation);
  const rotationB = matFromQuaternion(b.orientation);
  const carried = applyMat3(rotationB, b.start);
  const inWorld: Vec3 = [
    b.position[0] - a.position[0] - carried[0],
    b.position[1] - a.position[1] - carried[1],
    b.position[2] - a.position[2] - carried[2],
  ];
  const back = applyMat3(transpose(rotationA), inWorld);
  return {
    rotation: mulMat3(transpose(rotationA), rotationB),
    translation: [back[0] + a.start[0], back[1] + a.start[1], back[2] + a.start[2]],
  };
}

const quaternionAngle = (a: Quaternion, b: Quaternion): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

/**
 * Bound on how far the distance between part A and part B can change over one recorded step, from the RELATIVE motion of B in A's frame
 * (the frame the distance is measured in): the step of B's centre `centre` (start-pose coordinates) under the relative transform, plus the
 * relative rotation angle times `radius` (largest distance from `centre` to a point of B). A pair moving together, or turning about a common
 * axis through B's centre, has a much smaller bound than the sum of both parts' absolute travel. The chord of the step is inflated by
 * `1 + (thetaA + thetaB)^2 / 4` for the arc the interpolated path takes inside the step (angles of the two bodies over the step).
 * @invariant never negative; with both parts still it is 0
 */
export function relativeTravelBound(a0: BodyPoseAt, a1: BodyPoseAt, b0: BodyPoseAt, b1: BodyPoseAt, centre: Vec3, radius: number): number {
  const [m0, m1] = [relativeTransform(a0, b0), relativeTransform(a1, b1)];
  const [c0, c1] = [applyMat3(m0.rotation, centre), applyMat3(m1.rotation, centre)];
  const chord = Math.hypot(
    c1[0] + m1.translation[0] - c0[0] - m0.translation[0],
    c1[1] + m1.translation[1] - c0[1] - m0.translation[1],
    c1[2] + m1.translation[2] - c0[2] - m0.translation[2],
  );
  // relative rotation R0^T R1: angle from its trace
  const [r0, r1] = [m0.rotation, m1.rotation];
  let trace = 0;
  for (let row = 0; row < 3; row++) for (let k = 0; k < 3; k++) trace += (r0[k * 3 + row] ?? 0) * (r1[k * 3 + row] ?? 0);
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  const turned = quaternionAngle(a0.orientation, a1.orientation) + quaternionAngle(b0.orientation, b1.orientation);
  return (chord + angle * radius) * (1 + (turned * turned) / 4);
}
