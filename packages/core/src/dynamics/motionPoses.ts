/**
 * Body poses along a simulated run for the motion-clearance check (PHY-21 TR-FPR-10): interpolation between samples, motion
 * detection, travel bounds and the rigid transform that carries one start-pose mesh into another's frame.
 * @invariant pure; poses between two samples are lerp (centre of mass) and slerp (orientation)
 */

import type { Vec3 } from '../model/vectors';
import { applyMat3, mulMat3, type Mat3 } from '../lib/axisRotation';
import type { RigidTransform } from '../geometry/meshBvh';
import { type BodyPoseAt, matFromQuaternion } from './bodyPose';
import type { Quaternion } from './physicsEngine';

/** Centre-of-mass positions (document units) and rotations from the start pose of one body, one entry per sample. */
export interface PoseTrack {
  readonly position: readonly Vec3[];
  readonly orientation: readonly Quaternion[];
}

/** Pose of a part that never moves: the identity motion. */
export const STATIC_POSE: BodyPoseAt = { start: [0, 0, 0], position: [0, 0, 0], orientation: [1, 0, 0, 0] };

const TINY = 1e-9;

function slerp(a: Quaternion, b: Quaternion, fraction: number): Quaternion {
  const raw = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = raw < 0 ? -1 : 1;
  const cos = Math.min(1, raw * sign);
  const angle = Math.acos(cos);
  const sin = Math.sin(angle);
  const [wa, wb] =
    sin < 1e-9 ? [1 - fraction, fraction * sign] : [Math.sin((1 - fraction) * angle) / sin, (Math.sin(fraction * angle) / sin) * sign];
  const q = [0, 1, 2, 3].map((k) => wa * (a[k] ?? 0) + wb * (b[k] ?? 0));
  const norm = Math.hypot(...q) || 1;
  return [(q[0] ?? 0) / norm, (q[1] ?? 0) / norm, (q[2] ?? 0) / norm, (q[3] ?? 0) / norm];
}

/** Pose of a body at sample `index` plus `fraction` (0..1) of the way to the next sample. */
export function poseAt(track: PoseTrack, index: number, fraction: number): BodyPoseAt {
  const start = track.position[0] ?? [0, 0, 0];
  const here = track.position[index] ?? start;
  const hereQ = track.orientation[index] ?? STATIC_POSE.orientation;
  if (fraction <= 0 || index + 1 >= track.position.length) return { start, position: here, orientation: hereQ };
  const next = track.position[index + 1] ?? here;
  const nextQ = track.orientation[index + 1] ?? hereQ;
  return {
    start,
    position: [
      here[0] + (next[0] - here[0]) * fraction,
      here[1] + (next[1] - here[1]) * fraction,
      here[2] + (next[2] - here[2]) * fraction,
    ],
    orientation: slerp(hereQ, nextQ, fraction),
  };
}

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
